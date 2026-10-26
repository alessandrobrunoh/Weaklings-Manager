# Frontend

Angular CLI is installed at `^21.2.17`, and the app uses Angular `^21.2.0`. This private frontend package uses AnalogJS and Vite for its application and build workflow, with Vitest for tests.

## Overview

The root HTML mounts `<app-root>` and loads `/src/main.ts`. Analog enables server rendering; the app also has client bootstrap, server bootstrap, and a server-side gateway for backend API and Scalar requests. The main source boundaries are indexed in [src](src/README.md).

## Interface

- `index.html` is the browser entry document; `vite.config.ts` default-exports the Vite/Analog configuration.
- Package scripts are the supported development interface: `dev`, `start`, `build`, `preview`, `test`, and `serve:ssr:frontend`.
- `/api` and `/scalar` proxy to `API_REWRITE_URL`, or to `http://localhost:${BACKEND_PORT ?? '3000'}`.

## Invariants

- Analog SSR is enabled; static output is disabled and the prerender route list is empty.
- Vite writes client build output to `dist/client`; the SSR start script targets `dist/analog/server/index.mjs`.
- TypeScript is strict, and the app configuration excludes `*.spec.ts` files.

## Side Effects

Vite configuration evaluation loads repository-root environment variables into `process.env`. The dev plugin installs a process-level `unhandledRejection` listener, and the root HTML loads Google Fonts from Google-hosted URLs.

## Development server

To start a local development server, run:

```bash
npm run dev --prefix apps/frontend
```

Vite prints the local URL when it starts and reloads the app as source files change.

## Code scaffolding

Angular CLI remains available as a development dependency for Angular schematics. This package does not define a separate scaffolding script; consult the CLI command reference and follow the standalone component patterns used by the app.

The Vite/Analog scripts below are the configured application commands; `ng serve`, `ng build`, and `ng test` are not package scripts.

## Building

Build the application with:

```bash
npm run build --prefix apps/frontend
```

The build emits client and server artifacts under `dist/`. To serve the generated SSR bundle, run `npm run serve:ssr:frontend --prefix apps/frontend` after building. `npm run preview --prefix apps/frontend` starts the Vite preview server.

## Running unit tests

The package's test script invokes Vitest:

```bash
npm test --prefix apps/frontend
```

No end-to-end test script is configured in this package.

## Additional Resources

For Angular CLI command references and schematics, see the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli).

## Verification

From the repository root, run `npm test --prefix apps/frontend`. This is the configured frontend test target.
