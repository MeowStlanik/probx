# ProbX full-stack deployment on Railway

The canonical deployment instructions are in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

The checked-in `railway.json` builds and starts the full Next.js application:

```text
Build: pnpm --filter @probx/web build
Start: pnpm --filter @probx/web start
Health: /api/health
```

The UI, same-origin API routes and persistent workers run in one Railway process. Use
`.env.railway.fullstack.example` as the production variable template.
