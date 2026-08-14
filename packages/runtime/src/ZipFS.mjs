// Zip-backed lazy filesystem for Emscripten's legacy FS.
//
// The compressed app zip stays resident (~10 MB); file metadata comes from the
// zip central directory; file CONTENT is hydrated synchronously on first read
// (fflate inflateSync — no Asyncify anywhere near the FS) and LRU-evicted by
// dropping the JS-heap reference. Method-0 (stored) entries hydrate as zero-copy
// subarray views into the resident zip buffer. Replaces "extract 7,000 files
// into MEMFS at boot" — which was both the boot-time cost and ~30 MB of
// permanent residency.
import { inflateSync } from 'fflate';

const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_SIG = 0x04034b50;

function dosDateToUnix(dosTime, dosDate) {
	return Date.UTC(
		((dosDate >> 9) & 0x7f) + 1980,
		((dosDate >> 5) & 0x0f) - 1,
		dosDate & 0x1f,
		(dosTime >> 11) & 0x1f,
		(dosTime >> 5) & 0x3f,
		(dosTime << 1) & 0x3e,
	);
}

/** Parse the central directory into path → entry plus a directory index. */
export function parseZip(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
		if (view.getUint32(i, true) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error('ZipFS: EOCD not found');

	const count = view.getUint16(eocd + 10, true);
	let offset = view.getUint32(eocd + 16, true);

	const decoder = new TextDecoder();
	const files = new Map(); // path -> entry
	const dirs = new Map([['', new Map()]]); // dirPath -> Map(childName -> entry|null(dir))

	const ensureDir = (path) => {
		if (dirs.has(path)) return;
		ensureDir(path.slice(0, Math.max(path.lastIndexOf('/'), 0)));
		const parent = path.slice(0, Math.max(path.lastIndexOf('/'), 0));
		const name = path.slice(path.lastIndexOf('/') + 1);
		dirs.get(parent).set(name, null);
		dirs.set(path, new Map());
	};

	for (let i = 0; i < count; i++) {
		if (view.getUint32(offset, true) !== CENTRAL_SIG) throw new Error('ZipFS: bad central directory');
		const method = view.getUint16(offset + 10, true);
		const dosTime = view.getUint16(offset + 12, true);
		const dosDate = view.getUint16(offset + 14, true);
		const csize = view.getUint32(offset + 20, true);
		const usize = view.getUint32(offset + 24, true);
		const nameLen = view.getUint16(offset + 28, true);
		const extraLen = view.getUint16(offset + 30, true);
		const commentLen = view.getUint16(offset + 32, true);
		const localOffset = view.getUint32(offset + 42, true);
		const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
		offset += 46 + nameLen + extraLen + commentLen;

		if (name.endsWith('/')) {
			ensureDir(name.slice(0, -1));
			continue;
		}
		const slash = name.lastIndexOf('/');
		const dir = slash >= 0 ? name.slice(0, slash) : '';
		ensureDir(dir);
		const entry = { method, csize, usize, localOffset, mtime: dosDateToUnix(dosTime, dosDate) };
		files.set(name, entry);
		dirs.get(dir).set(name.slice(slash + 1), entry);
	}

	return { files, dirs };
}

function entryBytes(zip, view, entry) {
	// Local header carries its own name/extra lengths — never trust the central copy.
	const lo = entry.localOffset;
	if (view.getUint32(lo, true) !== LOCAL_SIG) throw new Error('ZipFS: bad local header');
	const nameLen = view.getUint16(lo + 26, true);
	const extraLen = view.getUint16(lo + 28, true);
	const start = lo + 30 + nameLen + extraLen;
	const raw = zip.subarray(start, start + entry.csize);
	if (entry.method === 0) return raw; // stored: zero-copy view into the resident zip
	if (entry.method === 8) return inflateSync(raw, { out: new Uint8Array(entry.usize) });
	throw new Error(`ZipFS: unsupported compression method ${entry.method}`);
}

/**
 * Create and mount the zip filesystem. Returns the LRU controller.
 *
 * @param {object} FS         Emscripten FS from the module
 * @param {Uint8Array} zip    Resident zip bytes
 * @param {string} mountpoint e.g. '/app'
 * @param {number} budget     Hydrated-bytes budget before LRU eviction
 */
export function mountZip(FS, zip, mountpoint, budget = 16 * 1024 * 1024) {
	const { files, dirs } = parseZip(zip);
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

	// LRU over hydrated, clean, evictable nodes.
	const lru = new Map(); // node -> byteLength (Map preserves insertion order)
	let hydratedBytes = 0;

	const evictIfNeeded = () => {
		for (const [node, size] of lru) {
			if (hydratedBytes <= budget) break;
			if (node.stream_shared_refs > 0 || node.zipDirty) continue;
			node.contents = null;
			lru.delete(node);
			hydratedBytes -= size;
		}
	};

	const hydrate = (node) => {
		if (node.contents) {
			// refresh LRU position
			if (lru.has(node)) {
				const s = lru.get(node);
				lru.delete(node);
				lru.set(node, s);
			}
			return node.contents;
		}
		const bytes = entryBytes(zip, view, node.zipEntry);
		node.contents = bytes;
		if (node.zipEntry.method !== 0) {
			// Stored entries alias the resident zip — free. Only count inflated copies.
			lru.set(node, bytes.byteLength);
			hydratedBytes += bytes.byteLength;
			evictIfNeeded();
		}
		return bytes;
	};

	const relPath = (node) => {
		let path = node.name;
		let current = node.parent;
		while (current && current !== current.parent && current !== ZIPFS.root) {
			path = current.name + '/' + path;
			current = current.parent;
		}
		return current === ZIPFS.root ? path : node.name;
	};

	const MODE_FILE = 0o100644;
	const MODE_DIR = 0o40755;

	const ZIPFS = {
		root: null,

		mount() {
			ZIPFS.root = ZIPFS.createNode(null, '/', MODE_DIR, '');
			return ZIPFS.root;
		},

		createNode(parent, name, mode, dirPath, entry = null) {
			const node = FS.createNode(parent, name, mode);
			node.node_ops = ZIPFS.node_ops;
			node.stream_ops = ZIPFS.stream_ops;
			node.zipDir = dirPath;
			node.zipEntry = entry;
			node.contents = null;
			node.zipDirty = false;
			node.stream_shared_refs = 0;
			node.timestamp = entry ? entry.mtime : Date.now();
			return node;
		},

		node_ops: {
			getattr(node) {
				return {
					dev: 1,
					ino: node.id,
					mode: node.mode,
					nlink: 1,
					uid: 0,
					gid: 0,
					rdev: 0,
					size: FS.isDir(node.mode) ? 4096 : (node.zipDirty ? node.contents.length : node.zipEntry?.usize ?? node.contents?.length ?? 0),
					atime: new Date(node.timestamp),
					mtime: new Date(node.timestamp),
					ctime: new Date(node.timestamp),
					blksize: 4096,
					blocks: 1,
				};
			},
			setattr(node, attr) {
				if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
				if (attr.size !== undefined && !FS.isDir(node.mode)) {
					// truncate (used by open with O_TRUNC on promoted writes)
					const old = node.contents ? node.contents : hydrate(node);
					const next = new Uint8Array(attr.size);
					next.set(old.subarray(0, Math.min(old.length, attr.size)));
					node.contents = next;
					node.zipDirty = true;
				}
			},
			lookup(parent, name) {
				const dirPath = parent === ZIPFS.root ? '' : (parent.zipDir ? parent.zipDir + '/' + parent.name : parent.name);
				const children = dirs.get(dirPath);
				if (!children || !children.has(name)) {
					throw new FS.ErrnoError(44); // ENOENT
				}
				const entry = children.get(name);
				const childDirPath = dirPath;
				if (entry === null) {
					return ZIPFS.createNode(parent, name, MODE_DIR, childDirPath);
				}
				return ZIPFS.createNode(parent, name, MODE_FILE, childDirPath, entry);
			},
			readdir(node) {
				const dirPath = node === ZIPFS.root ? '' : (node.zipDir ? node.zipDir + '/' + node.name : node.name);
				const children = dirs.get(dirPath);
				return ['.', '..', ...(children ? children.keys() : [])];
			},
			mknod(parent, name, mode, dev) {
				// Allow new files (e.g. /app/.env) as overlay-in-place nodes.
				if (FS.isDir(mode)) {
					const dirPath = parent === ZIPFS.root ? '' : (parent.zipDir ? parent.zipDir + '/' + parent.name : parent.name);
					const self = dirPath ? dirPath + '/' + name : name;
					if (!dirs.has(self)) {
						(dirs.get(dirPath) ?? dirs.set(dirPath, new Map()).get(dirPath)).set(name, null);
						dirs.set(self, new Map());
					}
					return ZIPFS.createNode(parent, name, MODE_DIR, dirPath);
				}
				const node = ZIPFS.createNode(parent, name, mode | 0o100000, parent === ZIPFS.root ? '' : (parent.zipDir ? parent.zipDir + '/' + parent.name : parent.name));
				node.contents = new Uint8Array(0);
				node.zipDirty = true;
				const dirPath = node.zipDir;
				(dirs.get(dirPath) ?? dirs.set(dirPath, new Map()).get(dirPath)).set(name, { method: -1 });
				return node;
			},
			rename(oldNode, newDir, newName) {
				// In-memory move (Laravel writes compiled views as temp + rename).
				const dirPathOf = (n) => (n === ZIPFS.root ? '' : (n.zipDir ? n.zipDir + '/' + n.name : n.name));
				const oldDirPath = dirPathOf(oldNode.parent);
				const newDirPath = dirPathOf(newDir);
				const oldChildren = dirs.get(oldDirPath);
				const record = oldChildren?.get(oldNode.name) ?? { method: -1 };
				oldChildren?.delete(oldNode.name);
				if (!dirs.has(newDirPath)) dirs.set(newDirPath, new Map());
				dirs.get(newDirPath).set(newName, record);
				const oldFull = oldDirPath ? `${oldDirPath}/${oldNode.name}` : oldNode.name;
				const newFull = newDirPath ? `${newDirPath}/${newName}` : newName;
				if (files.has(oldFull)) {
					files.set(newFull, files.get(oldFull));
					files.delete(oldFull);
				}
				oldNode.name = newName;
				oldNode.parent = newDir;
				oldNode.zipDir = newDirPath;
			},
			unlink(parent, name) {
				const dirPath = parent === ZIPFS.root ? '' : (parent.zipDir ? parent.zipDir + '/' + parent.name : parent.name);
				dirs.get(dirPath)?.delete(name);
				const full = dirPath ? dirPath + '/' + name : name;
				files.delete(full);
			},
			rmdir() { throw new FS.ErrnoError(63); },
			symlink() { throw new FS.ErrnoError(63); },
			readlink() { throw new FS.ErrnoError(28); },
		},

		stream_ops: {
			open(stream) {
				stream.node.stream_shared_refs++;
			},
			close(stream) {
				stream.node.stream_shared_refs--;
			},
			read(stream, buffer, offset, length, position) {
				const contents = stream.node.zipDirty ? stream.node.contents : hydrate(stream.node);
				if (position >= contents.length) return 0;
				const size = Math.min(contents.length - position, length);
				buffer.set(contents.subarray(position, position + size), offset);
				return size;
			},
			write(stream, buffer, offset, length, position) {
				const node = stream.node;
				const base = node.zipDirty ? node.contents : (node.zipEntry ? hydrate(node) : new Uint8Array(0));
				if (position + length > base.length) {
					const next = new Uint8Array(position + length);
					next.set(base);
					node.contents = next;
				} else if (!node.zipDirty) {
					node.contents = base.slice(); // copy-on-write off the zip backing
				}
				node.contents.set(buffer.subarray(offset, offset + length), position);
				node.zipDirty = true;
				if (lru.has(node)) {
					hydratedBytes -= lru.get(node);
					lru.delete(node);
				}
				return length;
			},
			llseek(stream, offset, whence) {
				let position = offset;
				if (whence === 1) position += stream.position;
				else if (whence === 2 && FS.isFile(stream.node.mode)) {
					const contents = stream.node.zipDirty ? stream.node.contents : stream.node.zipEntry;
					position += stream.node.zipDirty ? contents.length : (contents?.usize ?? 0);
				}
				if (position < 0) throw new FS.ErrnoError(28);
				return position;
			},
			mmap() {
				// Refuse cleanly: PHP's stream layer falls back to regular reads when
				// mmap fails, and copying into wasm linear memory would be permanent
				// (it never shrinks) — the opposite of what this FS exists to do.
				throw new FS.ErrnoError(43); // ENODEV
			},
		},
	};

	let current = '';
	for (const segment of mountpoint.split('/')) {
		if (!segment) continue;
		current += '/' + segment;
		if (!FS.analyzePath(current).exists) FS.mkdir(current);
	}
	FS.mount(ZIPFS, {}, mountpoint);
	return {
		stats: () => ({ hydratedBytes, entries: files.size }),
		files,
		dirs,
	};
}
