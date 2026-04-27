---
name: providers-and-models
description: Reference for Witsy's LLM provider and model architecture. Covers how chat / vision / image / embedding models are discovered, filtered, classified and persisted; the responsibilities of LlmFactory, LlmManager, LlmManagerBase, multi-llm-ts loaders, the per-provider Settings*.vue panels, ModelSelectPlus and Combobox; the OpenRouter dual-catalog quirk (`/api/v1/models` vs `?output_modalities=embeddings`) and the MistralAI embedding bypass; testing patterns (prototype mocks, vi.stubGlobal fetch, vi.waitUntil) and diagnostic logs. Use when adding a new provider, debugging an empty chat / vision / embedding combobox, modifying capability icons, or touching `src/renderer/services/llms/`.
license: Proprietary (internal Witsy technical documentation)
compatibility: Witsy renderer (Vue 3 + Electron + multi-llm-ts)
metadata:
  author: witsy-engineering
  version: "1.0"
  audience: contributors, maintainers, AI agents
  scope: src/renderer/services/llms, src/renderer/settings, multi-llm-ts integration
  keywords: "llm provider model embedding chat vision openrouter mistralai openai anthropic ollama lmstudio rag combobox modelselectplus llmfactory llmmanager llmmanagerbase savemodels selectvalidmodel loadmodels loadopenroutermodelsall loadmistralaimodelsall multi-llm-ts modelslist modelcapabilities settings refresh"
---

# Providers & Models — Architecture, Discovery, Filtering

This document captures the architecture and information flow for LLM providers
and their models in Witsy, including the gotchas we discovered while fixing the
embedding-model discovery for OpenRouter.

---

## 1. High-level picture

```
                                  Renderer (Vue 3)
   ┌──────────────────────────────────────────────────────────────────────┐
   │                                                                      │
   │  SettingsXxx.vue (per-provider)                                      │
   │     │                                                                │
   │     │ load() reads store.config.engines[engine]                      │
   │     │ getModels() / refresh button                                   │
   │     ▼                                                                │
   │  LlmFactory.manager(store.config) ──▶ LlmManager (renderer)          │
   │                                          │  extends LlmManagerBase   │
   │                                          ▼                           │
   │                            loadModels(engine)                        │
   │                                          │                           │
   │                                          ▼                           │
   │      ┌──────────────────────────────────────────────────────────┐    │
   │      │ multi-llm-ts: provider loaders + provider classes        │    │
   │      │   loadOpenAIModels / loadAnthropicModels / ...           │    │
   │      │   OpenAI / OpenRouter / MistralAI / ...                  │    │
   │      └──────────────────────────────────────────────────────────┘    │
   │                                          │                           │
   │                                          ▼ ModelsList                │
   │                            saveModels(engine, models)                │
   │                                          │                           │
   │                                          ▼                           │
   │                        store.config.engines[engine].models           │
   │                                          │                           │
   │                                          ▼                           │
   │  ModelSelectPlus / Combobox bound to chat_models, embedding_models … │
   │                                                                      │
   └──────────────────────────────────────────────────────────────────────┘
```

The renderer is the only place where models are loaded and persisted to the
config. The main process consumes the persisted models when running RAG /
chat pipelines but does **not** call provider listing endpoints itself.

---

## 2. Key types (`multi-llm-ts`)

```ts
type Model = {
  id: string
  name: string
  meta?: ModelMetadata     // raw provider payload, kept for capability re-derivation
}

type ChatModel = Model & {
  capabilities: ModelCapabilities  // { tools, vision, reasoning, caching }
}

type ModelsList = {
  chat:       ChatModel[]
  image?:     Model[]
  video?:     Model[]
  embedding?: Model[]      // ← optional; can be missing or empty
  realtime?:  Model[]
  computer?:  Model[]
  tts?:       Model[]
  stt?:       Model[]
}
```

`meta` is preserved verbatim for two reasons:

1. `LlmEngine.getModelCapabilities(meta)` re-derives capability flags later
   (`base.checkModelsCapabilities()` heals models saved before capabilities
   existed).
2. We re-classify embedding vs chat by re-reading provider-specific fields
   (`architecture.modality`, `capabilities.embeddings`, etc.).

---

## 3. File responsibilities

| Path | Role |
|---|---|
| `src/renderer/services/llms/llm.ts` | `LlmFactory.manager(config)` returns the singleton-ish renderer manager; also exports the `favoriteMockEngine` constant and tool-list helpers. |
| `src/renderer/services/llms/base.ts` | `LlmManagerBase`: shared logic (favorites, custom engines, `initModels`, `loadModelsCustom`, `saveModels`, `selectValidModel`, `checkModelsCapabilities`, …). Engine-agnostic. |
| `src/renderer/services/llms/manager.ts` | `LlmManager extends LlmManagerBase`: per-provider dispatch in `loadModels` + `igniteEngine` + `isEngineConfigured/Ready`. Also hosts our OpenRouter / MistralAI custom loaders (see §6). |
| `src/renderer/services/llms/{anthropic,google,ollama,openrouter}.ts` | Local subclasses of `multi-llm-ts` providers when we need to override behaviour (e.g. Anthropic computer-use info, OpenRouter readiness checks). |
| `src/renderer/settings/Settings*.vue` | Per-provider settings panel. Reads/writes `store.config.engines[engine]` and triggers `llmManager.loadModels()` via the refresh button or on api-key blur. |
| `src/renderer/components/ModelSelectPlus.vue` | Chat/vision selector: shows capability icons by reading `model.capabilities`. Used for chat & vision pickers. |
| `src/renderer/components/Combobox.vue` | Free-typing combobox: used for embedding selection (allows manually entering a model id not yet in the discovered list). |
| `src/types/config.ts` | `Configuration`, `EngineConfig`. Persisted to disk through `store.saveSettings()`. |
| `multi-llm-ts` (`node_modules/multi-llm-ts/dist`) | Provider classes (`OpenAI`, `OpenRouter`, `MistralAI`, …) and per-provider top-level loaders (`loadOpenAIModels`, …). The loaders are convenience wrappers that call `provider.getModels()` and bucket the result. |

---

## 4. Information flow when refreshing models

1. The user clicks the refresh button (`<RefreshButton :on-refresh="getModels" />`)
   in `SettingsXxx.vue`, or blurs the api-key field with empty `chat_models`.
2. The component calls `llmManager.loadModels(engine)`.
3. `LlmManager.loadModels` dispatches:
   - **Standard engines** → `multi-llm-ts` loader (`loadAnthropicModels`,
     `loadOpenAIModels`, …) → returns a `ModelsList`.
   - **OpenRouter / MistralAI** → our custom loaders
     `loadOpenRouterModelsAll` / `loadMistralAIModelsAll` (see §6).
   - **Custom engines** → `LlmManagerBase.loadModelsCustom`, which dispatches
     on `engineConfig.api` (`'openai'` → `loadOpenAIModels`, `'azure'` →
     `loadAzureModels`).
4. `LlmManagerBase.saveModels(engine, models)`:
   - Engine-specific cosmetic tweaks (OpenAI name capitalisation, Google
     ordering, hide-dated filter, …).
   - Stores `engineConfig.models = { chat: [], image: [], ...models }`.
   - Calls `selectValidModel(engine, engineConfig, 'chat')` and
     `…, 'image')` to pick a default if the previously-selected one disappeared.
   - Calls `store.saveSettings()` only when the JSON of `engineConfig`
     actually changed.
5. The Vue component's `getModels()` then calls `load()` to refresh local refs
   (`chat_models`, `embedding_models`, …) from the store.
6. Vue reactivity propagates to `ModelSelectPlus` / `Combobox`.

`selectValidModel` only handles `chat` and `image`. Embedding selection is
**deliberately** user-driven: we never auto-pick an embedding model because
swapping embeddings invalidates the existing vector index of any RAG document
repository.

---

## 5. How each provider exposes models (the part that bit us)

| Provider | Endpoint(s) used by `multi-llm-ts` | Returns embedding models? | Notes |
|---|---|---|---|
| OpenAI | `GET /v1/models` (OpenAI SDK `client.models.list()`). The library's `loadOpenAIModels` *only* buckets embeddings into `embedding[]` if `engineConfig.baseURL` includes `api.openai.com`. | Yes (official OpenAI key only). | For OpenAI-compatible custom backends, `loadOpenAIModels` returns embeddings inside `chat[]`. We therefore source the embedding combobox from `chat_models` in `SettingsOpenAI.vue` and `SettingsCustomLLM.vue`. |
| Anthropic | `loadAnthropicModels` — has no embedding API. | No (Anthropic doesn't ship embedding models). | — |
| Google | `loadGoogleModels` — Gemini chat catalog only. | Embedding ids are present but mostly filtered out by name heuristics. | — |
| Mistral AI | `MistralAI.getModels()` returns the raw `/v1/models` payload, including embedding models flagged via `meta.capabilities.embeddings === true`. The library's `loadMistralAIModels` drops them and hard-codes `embedding: []`. | **Yes in raw, dropped by loader.** | We bypass the loader (see §6.2). |
| OpenRouter | `OpenRouter.getModels()` calls the OpenAI-compatible `GET /api/v1/models`. **This endpoint never returns embedding models.** They live on a *separate* catalog: `GET /api/v1/models?output_modalities=embeddings`. | **No on the standard endpoint.** | We do a parallel fetch (see §6.1). |
| Ollama / LMStudio | Local server `/api/tags` etc. Embedding models appear if the user has pulled them. | Yes. | — |
| Custom engine | `engineConfig.api` selects `loadOpenAIModels` or `loadAzureModels`. | Same caveats as OpenAI. | — |

---

## 6. Custom loaders in `manager.ts`

Both custom loaders preserve the exact same `Model.capabilities` you would get
from the library by calling `provider.getModelCapabilities(meta)`, so the
capability icons in `ModelSelectPlus` are consistent with how the library
would have rendered the chat list.

### 6.1 `loadOpenRouterModelsAll`

```text
fetch ──┬─▶ OpenRouter.getModels()                          → chat metas
        └─▶ GET ${baseURL}/models?output_modalities=embeddings → embedding metas
                                  │
                                  ▼
       merge → { chat, image, embedding } ModelsList
```

- The embedding catalog is fetched directly with `fetch()` because the OpenAI
  SDK that backs `OpenRouter` only knows about `/models`.
- Authorization: `Authorization: Bearer ${engineConfig.apiKey}` is sent if
  configured. The endpoint is also reachable anonymously, so a missing key
  still works.
- A safety net catches "accidental" embeddings (any chat-meta whose
  `architecture.modality` ends in `embed`/`embeddings` or whose id contains
  `embed`) and routes them to the embedding bucket.
- Diagnostic log on each refresh:
  `[openrouter] loaded N chat metas, M embedding metas`.

OpenRouter embedding-model metadata format (note **plural** `embeddings`):

```json
{
  "id": "baai/bge-m3",
  "architecture": {
    "modality": "text->embeddings",
    "input_modalities":  ["text"],
    "output_modalities": ["embeddings"]
  }
}
```

### 6.2 `loadMistralAIModelsAll`

- Calls `MistralAI.getModels()` once and re-implements the library's
  alias-deduplication (the `…-latest` collapsing).
- Re-buckets via `meta.capabilities.embeddings === true` for embeddings and
  `meta.capabilities.completionChat === true` for chat.
- `image: []` (Mistral has no image generation).

### 6.3 Why custom loaders instead of patching `multi-llm-ts`?

The library's per-provider loaders are deliberately conservative (chat-only)
and would require an upstream change to expose embeddings. Keeping the override
in `manager.ts` lets us:

- Stay on stock `multi-llm-ts` versions.
- Reuse `provider.getModelCapabilities()` for icon parity.
- Diagnose easily (single file, console logs, no provider patching).

---

## 7. Settings UI patterns

All four embedding-aware settings panels share the same skeleton:

```ts
const chat_models      = ref<ChatModel[]>([])      // for ModelSelectPlus + capability icons
const embedding_models = ref<Model[]>([])          // sourced per-provider, see below
const embedding_model  = ref<string>('')           // currently-selected id (free-typed allowed)

const embedding_models_items = computed(() =>
  embedding_models.value.map(m => ({ id: m.id, name: m.name || m.id }))
)
```

Source of `embedding_models`:

| Component | Source |
|---|---|
| `SettingsOpenAI.vue` | `chat_models` (library bucketing handles official OpenAI only; for other base URLs the embedding ids appear in the chat list anyway). |
| `SettingsCustomLLM.vue` | `chat_models` (same reason). |
| `SettingsOpenRouter.vue` | `store.config.engines.openrouter.models.embedding` populated by `loadOpenRouterModelsAll`. |
| `SettingsMistralAI.vue` | `store.config.engines.mistralai.models.embedding` populated by `loadMistralAIModelsAll`. |

The embedding combobox always uses `<Combobox>` (free-text input) rather than
`<ModelSelectPlus>` so users can paste an id Witsy hasn't discovered (private
deployments, brand-new providers, etc.).

---

## 8. Capability icons

`ModelSelectPlus` reads `chatModel.capabilities` (a `ModelCapabilities` object
of four booleans). `provider.getModelCapabilities(meta)` is the single source
of truth — both `multi-llm-ts` loaders and our custom loaders call it on the
raw `meta` so the chat/vision/embedding lists are coherent and can be re-derived
on demand by `LlmManagerBase.checkModelsCapabilities()`.

---

## 9. Testing patterns

- Tests in `tests/unit/renderer/services/llms/llm2.test.ts` and
  `tests/unit/renderer/screens/settings_models.test.ts`.
- For OpenRouter / MistralAI we **stub on the class prototype** so our
  subclass `OpenRouter extends llm.OpenRouter` still works:

  ```ts
  vi.mock('multi-llm-ts', async (orig) => {
    const mod: any = await orig()
    mod.OpenRouter.prototype.getModels = vi.fn(async () => […])
    mod.OpenRouter.prototype.getModelCapabilities = vi.fn(() => ({ … }))
    return mod
  })
  ```

- `loadOpenRouterModelsAll` calls `fetch()` directly. Tests must
  `vi.stubGlobal('fetch', vi.fn(…))` (and `vi.unstubAllGlobals()` in
  `afterEach`) — otherwise the test hits the real OpenRouter API and either
  flakes on network or returns a different model count, breaking
  `toHaveBeenCalledTimes(N)` assertions on `window.api.config.save`.
- `getModels()` triggered via `onKeyChange` is fire-and-forget. Tests must
  `await vi.waitUntil(() => store.config.engines.openrouter.models?.embedding?.length)`
  before asserting on the embedding bucket (per the AGENTS.md guidance: prefer
  `vi.waitUntil` over `await Promise(...)`).

---

## 10. Diagnostic hooks

When investigating an empty/odd model list:

1. Open the renderer DevTools console.
2. Trigger the refresh on the settings panel.
3. Look for the structured logs:
   - `Loading models for <engine>` (from `manager.loadModels`)
   - `[openrouter] loaded N chat metas, M embedding metas`
4. Inspect `store.config.engines.<engine>.models` from the DevTools console:
   ```js
   window.__store__?.config?.engines?.openrouter?.models   // chat / image / embedding arrays
   ```
   (or just open the in-app settings JSON viewer, if available).
5. If the bucket is empty, the next steps are:
   - Confirm the raw provider payload is what we think it is by hitting the
     endpoint with `curl` (see the OpenRouter URLs in §5).
   - Confirm the classification predicate (`isEmbeddingMeta`, `caps(m).embeddings`)
     against an actual `meta` object.

---

## 11. Known limitations / open items

- **Mistral validation**: the assumption that
  `MistralAI.getModels()` returns embedding models with
  `capabilities.embeddings === true` was reverse-engineered from the library
  source; if the embedding combobox stays empty for a given Mistral key, the
  same diagnostic procedure as OpenRouter (§10) applies.
- **OpenRouter pagination**: the embeddings catalog currently fits in a single
  response (~25 models). If OpenRouter ever paginates `?output_modalities=embeddings`
  the loader will need to follow `links.next`.
- **Capability icons for embeddings**: `Combobox` does not render capability
  icons. If we ever want them, switching the embedding picker to a
  `ModelSelectPlus` (with free-typing enabled) is the path.
- **Initial load**: `LlmManagerBase.initModels` only calls `loadModels` for
  engines listed in `multi-llm-ts.staticModelsListEngines` (currently empty).
  In practice models are loaded lazily on first settings open or on explicit
  refresh.
