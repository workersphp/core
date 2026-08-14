// Static asset publishing: the app's public/ tree plus vendor-served JS
// discovered at bake time. Requests these can satisfy never boot PHP.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LIVEWIRE_CANONICAL_PREFIX } from '../../laravel/src/index.mjs';
import { log } from './constants.mjs';

export function publishAssets({ appDir, deployDir }) {
	log('publishing static assets');
	// tar, not `install -D`: BSD install has different -D semantics and the old
	// find -exec form failed silently on macOS (find exits 0 either way).
	execFileSync('bash', ['-c',
		`cd '${appDir}/public' && tar -c --exclude ./index.php --exclude ./.htaccess -f - . | tar -x -f - -C '${deployDir}/assets'`,
	]);

	const manifestPath = appDir + '/.bake-asset-manifest.json';
	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		for (const [urlPath, file] of Object.entries(manifest)) {
			// Livewire's endpoint prefix hashes APP_KEY, which differs between the
			// bake's dummy key and the deployed secret. Publish under a stable path;
			// the runtime rewrites incoming /livewire-<hash>/ script requests to it.
			const canonical = urlPath.replace(/^\/livewire-[0-9a-f]+\//, LIVEWIRE_CANONICAL_PREFIX);
			const target = deployDir + '/assets' + canonical;
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(file.replace(/^\/app/, appDir), target);
		}
		log(`extracted ${Object.keys(manifest).length} vendor asset(s)`);
	}
}
