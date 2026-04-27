
import { Configuration, EngineConfig } from 'types/config'
import Anthropic, { getComputerInfo } from './anthropic'
import LlmManagerBase from './base'
import * as llm from 'multi-llm-ts'
import Google from './google'
import Ollama from './ollama'
import OpenRouter from './openrouter'

export default class LlmManager extends LlmManagerBase {

  constructor(config: Configuration) {
    super(config)
  }

  // OpenRouter's `loadOpenRouterModels` drops embedding models (modality `text->embedding`)
  // and hardcodes `embedding: []`. We call getModels() ourselves and classify into all
  // three buckets, reusing `getModelCapabilities()` so chat capability icons are identical.
  private async loadOpenRouterModelsAll(engineConfig: EngineConfig): Promise<llm.ModelsList|null> {
    const provider = new llm.OpenRouter(engineConfig)
    let metas: Array<Record<string, unknown>> = []
    try {
      metas = (await provider.getModels() || []) as Array<Record<string, unknown>>
    } catch (error) {
      console.error('Error listing OpenRouter models:', error)
      return null
    }
    if (!metas.length) return null

    const models: llm.Model[] = metas.map(m => ({
      id: m.id as string,
      name: (m.name as string) || (m.id as string),
      capabilities: provider.getModelCapabilities(m),
      meta: m,
    }))

    const lastModality = (m: llm.Model): string => {
      const modality = ((m.meta as Record<string, unknown>)?.architecture as { modality?: string } | undefined)?.modality || ''
      return (modality.split('>').pop() || '').toLowerCase()
    }
    const isEmbedding = (m: llm.Model): boolean =>
      lastModality(m).includes('embedding') || /embed/i.test(m.id)

    const byName = (a: llm.Model, b: llm.Model) => a.name.localeCompare(b.name)

    return {
      chat: models.filter(m => !isEmbedding(m) && lastModality(m).includes('text')).sort(byName),
      image: models.filter(m => !isEmbedding(m) && lastModality(m).includes('image')).sort(byName),
      embedding: models.filter(m => isEmbedding(m)).sort(byName),
    }
  }

  // MistralAI's `loadMistralAIModels` filters by `meta.capabilities.completionChat` and
  // hardcodes `embedding: []`. Embedding models (e.g. `mistral-embed`) have
  // `meta.capabilities.embeddings === true`. We keep the library's alias de-dup logic
  // by calling its loader first for chat, then discover embeddings from the same API.
  private async loadMistralAIModelsAll(engineConfig: EngineConfig): Promise<llm.ModelsList|null> {
    const provider = new llm.MistralAI(engineConfig)
    let metas: Array<Record<string, unknown>> = []
    try {
      metas = (await provider.getModels() || []) as Array<Record<string, unknown>>
    } catch (error) {
      console.error('Error listing MistralAI models:', error)
      return null
    }
    if (!metas.length) return null

    // same alias de-duplication as multi-llm-ts
    const uniques: Array<Record<string, unknown>> = []
    const aliases = new Set<string>()
    for (const model of metas) {
      const id = model.id as string
      if (aliases.has(id)) continue
      const modelAliases = (model.aliases as string[] | undefined) || []
      const latest = modelAliases.filter(a => a.endsWith('-latest'))
      if (latest.length === 1) {
        model.id = latest[0]
        model.name = latest[0]
      }
      uniques.push(model)
      modelAliases.forEach(a => aliases.add(a))
    }

    const models: llm.Model[] = uniques.map(m => {
      const rawName = (m.name as string) || (m.id as string)
      return {
        id: m.id as string,
        name: rawName.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' '),
        capabilities: provider.getModelCapabilities(m),
        meta: m,
      }
    })

    const caps = (m: llm.Model) => ((m.meta as Record<string, unknown>)?.capabilities || {}) as Record<string, boolean>
    const isEmbedding = (m: llm.Model): boolean =>
      caps(m).embeddings === true || /embed/i.test(m.id)
    const isChat = (m: llm.Model): boolean =>
      caps(m).completionChat === true && !isEmbedding(m)

    const byName = (a: llm.Model, b: llm.Model) => a.name.localeCompare(b.name)

    return {
      chat: models.filter(isChat).sort(byName),
      image: [],
      embedding: models.filter(isEmbedding).sort(byName),
    }
  }

  getStandardEngines(): string[] {
    return [ 'openai', 'anthropic', 'google', 'xai', 'meta', 'ollama', 'lmstudio', 'mistralai', 'deepseek', 'openrouter', 'groq', 'cerebras' ]
  }

  getPriorityEngines(): string[] {
    return [ 'openai', 'anthropic', 'google', 'ollama' ]
  }

  getNonChatEngines(): string[] {
    return [ 'huggingface', 'replicate', 'elevenlabs', 'sdwebui', 'falai', 'gladia', 'nvidia', 'fireworks', 'speechmatics', 'soniox', 'minimax' ]
  }

  isEngineLocal(engine: string): boolean {
    return engine === 'ollama' || engine === 'lmstudio'
  }

  isEngineOnline(engine: string): boolean {
    return !this.isEngineLocal(engine)
  }

  isEngineConfigured(engine: string): boolean {
    if (engine === 'anthropic') return Anthropic.isConfigured(this.config.engines.anthropic)
    if (engine === 'cerebras') return llm.Cerebras.isConfigured(this.config.engines.cerebras)
    if (engine === 'deepseek') return llm.DeepSeek.isConfigured(this.config.engines.deepseek)
    if (engine === 'google') return Google.isConfigured(this.config.engines.google)
    if (engine === 'groq') return llm.Groq.isConfigured(this.config.engines.groq)
    if (engine === 'lmstudio') return llm.LMStudio.isConfigured(this.config.engines.lmstudio)
    if (engine === 'meta') return llm.Meta.isConfigured(this.config.engines.meta)
    if (engine === 'mistralai') return llm.MistralAI.isConfigured(this.config.engines.mistralai)
    if (engine === 'ollama') return Ollama.isConfigured(this.config.engines.ollama)
    if (engine === 'openai') return llm.OpenAI.isConfigured(this.config.engines.openai)
    if (engine === 'openrouter') return OpenRouter.isConfigured(this.config.engines.openrouter)
    if (engine === 'xai') return llm.XAI.isConfigured(this.config.engines.xai)
    if (this.isFavoriteEngine(engine)) return true
    if (this.isCustomEngine(engine)) return true
    return false
  }  
  
  isEngineReady(engine: string): boolean {
    if (engine === 'anthropic') return Anthropic.isReady(this.config.engines.anthropic, this.config.engines.anthropic?.models)
    if (engine === 'cerebras') return llm.Cerebras.isReady(this.config.engines.cerebras, this.config.engines.cerebras?.models)
    if (engine === 'deepseek') return llm.DeepSeek.isReady(this.config.engines.deepseek, this.config.engines.deepseek?.models)
    if (engine === 'google') return Google.isReady(this.config.engines.google, this.config.engines.google?.models)
    if (engine === 'groq') return llm.Groq.isReady(this.config.engines.groq, this.config.engines.groq?.models)
    if (engine === 'lmstudio') return llm.LMStudio.isReady(this.config.engines.lmstudio, this.config.engines.lmstudio?.models)
    if (engine === 'meta') return llm.Meta.isReady(this.config.engines.meta, this.config.engines.meta?.models)
    if (engine === 'mistralai') return llm.MistralAI.isReady(this.config.engines.mistralai, this.config.engines.mistralai?.models)
    if (engine === 'ollama') return Ollama.isReady(this.config.engines.ollama, this.config.engines.ollama?.models) 
    if (engine === 'openai') return llm.OpenAI.isReady(this.config.engines.openai, this.config.engines.openai?.models)
    if (engine === 'openrouter') return OpenRouter.isReady(this.config.engines.openrouter, this.config.engines.openrouter?.models)
    if (engine === 'xai') return llm.XAI.isReady(this.config.engines.xai, this.config.engines.xai?.models)
    if (this.isFavoriteEngine(engine)) return true
    if (this.isCustomEngine(engine)) return true
    return false
  }
  
  igniteEngine(engine: string): llm.LlmEngine {

    try {

      // super
      if (this.isFavoriteEngine(engine)) {
        return this.igniteFavoriteEngine(engine)
      } else if (this.isCustomEngine(engine)) {
        return this.igniteCustomEngine(engine)
      }

      // select
      if (engine === 'anthropic') return new Anthropic(this.config.engines.anthropic, getComputerInfo())
      if (engine === 'cerebras') return new llm.Cerebras(this.config.engines.cerebras)
      if (engine === 'deepseek') return new llm.DeepSeek(this.config.engines.deepseek)
      if (engine === 'google') return new Google(this.config.engines.google)
      if (engine === 'groq') return new llm.Groq({ ...this.config.engines.groq, maxRetries: 0 })
      if (engine === 'lmstudio') return new llm.LMStudio(this.config.engines.lmstudio)
      if (engine === 'meta') return new llm.Meta(this.config.engines.meta)
      if (engine === 'mistralai') return new llm.MistralAI(this.config.engines.mistralai)
      if (engine === 'ollama') return new Ollama(this.config.engines.ollama)
      if (engine === 'openai') return new llm.OpenAI(this.config.engines.openai)
      if (engine === 'openrouter') return new OpenRouter(this.config.engines.openrouter)
      if (engine === 'xai') return new llm.XAI(this.config.engines.xai)

    } catch (e) {
      console.error(`Error igniting engine ${engine}:`, e)
     }

    // fallback
    if (llm.OpenAI.isConfigured(this.config.engines.openai)) {
      console.warn(`Engine ${engine} unknown. Falling back to OpenAI`)
      return new llm.OpenAI(this.config.engines.openai)
    } else {
      console.error(`Engine ${engine} unknown.`)
      return null
    }

  }
  
  async loadModels(engine: string): Promise<boolean> {

    if (this.isCustomEngine(engine)) {
      return this.loadModelsCustom(engine)
    }
    
    console.log('Loading models for', engine)
    let models: llm.ModelsList|null = null
    if (engine === 'anthropic') {
      models = await llm.loadAnthropicModels(this.config.engines.anthropic, getComputerInfo())
    } else if (engine === 'cerebras') {
      models = await llm.loadCerebrasModels(this.config.engines.cerebras)
    } else if (engine === 'deepseek') {
      models = await llm.loadDeepSeekModels(this.config.engines.deepseek)
    } else if (engine === 'google') {
      models = await llm.loadGoogleModels(this.config.engines.google)
    } else if (engine === 'groq') {
      models = await llm.loadGroqModels(this.config.engines.groq)
    } else if (engine === 'lmstudio') {
      models = await llm.loadLMStudioModels(this.config.engines.lmstudio)
    } else if (engine === 'meta') {
      models = await llm.loadMetaModels(this.config.engines.meta)
    } else if (engine === 'mistralai') {
      models = await this.loadMistralAIModelsAll(this.config.engines.mistralai)
    } else if (engine === 'ollama') {
      models = await llm.loadOllamaModels(this.config.engines.ollama)
    } else if (engine === 'openai') {
      models = await llm.loadOpenAIModels(this.config.engines.openai)
    } else if (engine === 'openrouter') {
      models = await this.loadOpenRouterModelsAll(this.config.engines.openrouter)
    } else if (engine === 'xai') {
      models = await llm.loadXAIModels(this.config.engines.xai)
    }

    // // clear meta as we do not need it
    // for (const type of Object.keys(models || {})) {
    //   for (const model of models[type]) {
    //     delete model.meta
    //   }
    // }

    // save
    return this.saveModels(engine, models)
    
  }

}

