import { join } from 'pathe'

import {
  defineNuxtModule,
  installModule,
  isNuxt2,
  getNuxtVersion,
  resolvePath,
  useNuxt,
  addTemplate,
  createResolver,
  addImports,
  updateTemplates
} from '@nuxt/kit'

// @ts-expect-error
import defaultTailwindConfig from 'tailwindcss/stubs/config.simple.js'

import * as resolvers from './resolvers'
import logger, { LogLevels } from './logger'
import createConfigTemplates from './templates'
import { setupViewer, exportViewer } from './viewer'
import { name, version, configKey, compatibility } from '../package.json'

import type { ModuleHooks, ModuleOptions } from './types'
import { withTrailingSlash } from 'ufo'
import loadTwConfig from './config'
export type { ModuleOptions, ModuleHooks } from './types'

const deprecationWarnings = (moduleOptions: ModuleOptions, nuxt = useNuxt()) =>
  ([
    ['addTwUtil', 'Use `editorSupport.autocompleteUtil` instead.'],
    ['exposeLevel', 'Use `exposeConfig.level` instead.'],
    ['injectPosition', `Use \`cssPath: [${
      moduleOptions.cssPath === join(nuxt.options.dir.assets, 'css/tailwind.css')
        ? '"~/assets/css/tailwind.css"'
        : typeof moduleOptions.cssPath === 'string' ? `"${moduleOptions.cssPath}"` : moduleOptions.cssPath
    }, { injectPosition: ${JSON.stringify(moduleOptions.injectPosition)} }]\` instead.`]
  ] satisfies Array<[keyof ModuleOptions, string]>).forEach(
    ([dOption, alternative]) => moduleOptions[dOption] !== undefined && logger.warn(`Deprecated \`${dOption}\`. ${alternative}`)
  )

const defaults = (nuxt = useNuxt()): ModuleOptions => ({
  configPath: 'tailwind.config',
  cssPath: join(nuxt.options.dir.assets, 'css/tailwind.css'),
  config: defaultTailwindConfig,
  // mergingStrategy: 'defu',
  viewer: true,
  exposeConfig: false,
  disableHmrHotfix: false,
  quiet: nuxt.options.logLevel === 'silent',
  editorSupport: false,
})

export default defineNuxtModule<ModuleOptions>({
  meta: { name, version, configKey, compatibility }, defaults,
  async setup (moduleOptions, nuxt) {
    if (moduleOptions.quiet) logger.level = LogLevels.silent
    deprecationWarnings(moduleOptions, nuxt)

    const { resolve } = createResolver(import.meta.url)
    const twConfig = await loadTwConfig(moduleOptions, nuxt);

    // Expose resolved tailwind config as an alias
    if (moduleOptions.exposeConfig) {
      const exposeConfig = resolvers.resolveExposeConfig({ level: moduleOptions.exposeLevel, ...(typeof moduleOptions.exposeConfig === 'object' ? moduleOptions.exposeConfig : {})})
      const configTemplates = createConfigTemplates(twConfig, exposeConfig, nuxt)
      nuxt.hook('builder:watch', async (_, path) => {
        twConfig.configPaths.includes(join(nuxt.options.rootDir, path)) && await updateTemplates({ filter: template => configTemplates.includes(template.dst) })
      })
    }

    /** CSS file handling */
    const [cssPath, cssPathConfig] = Array.isArray(moduleOptions.cssPath) ? moduleOptions.cssPath : [moduleOptions.cssPath]
    const [resolvedCss, loggerInfo] = await resolvers.resolveCSSPath(
      typeof cssPath === 'string' ? await resolvePath(cssPath, { extensions: ['.css', '.sass', '.scss', '.less', '.styl'] }) : false, nuxt
    )
    logger.info(loggerInfo)

    nuxt.options.css = nuxt.options.css ?? []
    const resolvedNuxtCss = resolvedCss && await Promise.all(nuxt.options.css.map((p: any) => resolvePath(p.src ?? p))) || []

    // Inject only if this file isn't listed already by user (e.g. user may put custom path both here and in css):
    if (resolvedCss && !resolvedNuxtCss.includes(resolvedCss)) {
      let injectPosition: number
      try {
        injectPosition = resolvers.resolveInjectPosition(nuxt.options.css, cssPathConfig?.injectPosition || moduleOptions.injectPosition)
      } catch (e: any) {
        throw new Error('failed to resolve Tailwind CSS injection position: ' + e.message)
      }

      nuxt.options.css.splice(injectPosition, 0, resolvedCss)
    }


    /** PostCSS 8 support for Nuxt 2 */

    // Setup postcss plugins
    // https://tailwindcss.com/docs/using-with-preprocessors#future-css-features
    const postcssOptions =
      nuxt.options.postcss || /* nuxt 3 */ /* @ts-ignore */
      nuxt.options.build.postcss.postcssOptions || /* older nuxt3 */ /* @ts-ignore */
      nuxt.options.build.postcss as any
    postcssOptions.plugins = postcssOptions.plugins || {}
    postcssOptions.plugins['tailwindcss/nesting'] = postcssOptions.plugins['tailwindcss/nesting'] ?? {}
    postcssOptions.plugins['postcss-custom-properties'] = postcssOptions.plugins['postcss-custom-properties'] ?? {}
    postcssOptions.plugins.tailwindcss = twConfig.template.dst

    // install postcss8 module on nuxt < 2.16
    if (parseFloat(getNuxtVersion()) < 2.16) {
      await installModule('@nuxt/postcss8').catch((e) => {
        logger.error(`Error occurred while loading \`@nuxt/postcss8\` required for Nuxt ${getNuxtVersion()}, is it installed?`)
        throw e
      })
    }

    if (moduleOptions.editorSupport || moduleOptions.addTwUtil || isNuxt2()) {
      const editorSupportConfig = resolvers.resolveEditorSupportConfig(moduleOptions.editorSupport)

      if (editorSupportConfig.autocompleteUtil || moduleOptions.addTwUtil) {
        addImports({
          name: 'autocompleteUtil',
          from: resolve('./runtime/utils'),
          as: 'tw',
          ...(typeof editorSupportConfig.autocompleteUtil === 'object' ? editorSupportConfig.autocompleteUtil : {})
        })
      }
    }

    // enabled only in development
    if (nuxt.options.dev) {
      // Add _tailwind config viewer endpoint
      // TODO: Fix `addServerHandler` on Nuxt 2 w/o Bridge
      if (moduleOptions.viewer) {
        const viewerConfig = resolvers.resolveViewerConfig(moduleOptions.viewer)
        setupViewer(twConfig.tailwindConfig, viewerConfig, nuxt)

        // @ts-ignore
        nuxt.hook('devtools:customTabs', (tabs) => {
          tabs.push({
            title: 'TailwindCSS',
            name: 'tailwindcss',
            icon: 'logos-tailwindcss-icon',
            category: 'modules',
            view: {
              type: 'iframe',
              src: withTrailingSlash(viewerConfig.endpoint)
            }
          })
        })
      }
    } else {
      // production only
      if (moduleOptions.viewer) {
        const configTemplate = addTemplate({ filename: 'tailwind.config/viewer-config.cjs', getContents: () => `module.exports = ${JSON.stringify(twConfig.tailwindConfig)}`, write: true })
        exportViewer(configTemplate.dst, resolvers.resolveViewerConfig(moduleOptions.viewer))
      }
    }
  }
})

declare module 'nuxt/schema' {
  interface NuxtHooks extends ModuleHooks {}
}

declare module '@nuxt/schema' {
  interface NuxtHooks extends ModuleHooks {}
}
