# mastra-effect

Mastra adapter for Effect HTTP.

## Install

```bash
bun install
```

## Usage

### Direct adapter

```ts
import { mastra } from './mastra'
import { EffectHttpServer } from 'mastra-effect'
import { HttpRouter } from 'effect/http'
import { BunHttpServer } from 'effect/platform-bun'
import { Effect, Layer } from 'effect'

const router = HttpRouter.empty.pipe()
const server = new EffectHttpServer({ app: router, mastra })
await server.init()

Effect.runPromise(
  HttpRouter.serve().pipe(
    Layer.provide(Layer.sync(HttpRouter.HttpRouter, () => router)),
    Layer.provide(BunHttpServer.layer({ port: 3000 }))
  )
)
```

### Using the layer

```ts
import { mastra } from './mastra'
import { layerMastra } from 'mastra-effect'
import { HttpRouter } from 'effect/http'
import { BunHttpServer } from 'effect/platform-bun'
import { Effect, Layer } from 'effect'

Effect.runPromise(
  HttpRouter.serve().pipe(
    Layer.provide(layerMastra({ mastra })),
    Layer.provide(BunHttpServer.layer({ port: 3000 }))
  )
)
```

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
