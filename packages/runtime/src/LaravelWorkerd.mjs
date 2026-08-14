// Compatibility shim: the Laravel runtime now lives in @workersphp/laravel
// (adapter + scripts) over the framework-agnostic core in ./worker.mjs.
// Existing deployments import createLaravelWorker from this path; regenerated
// ones import the package directly. Delete once no deployment references it.
export { createLaravelWorker, laravelAdapter } from '../../laravel/src/index.mjs';
