'use strict';
// UI routing is exact: never borrow another provider or silently replace a requested model.
function activeProvider(doc) {
  if (!doc || typeof doc.active !== 'string' || !doc.active) return null;
  const provider = (Array.isArray(doc.providers) ? doc.providers : []).find(p => p && p.name === doc.active);
  return provider && typeof provider.url === 'string' && provider.url ? provider : null;
}
function providerModels(provider) {
  return [...new Set((provider && Array.isArray(provider.models) ? provider.models : [])
    .filter(m => typeof m === 'string' && m.trim()))];
}
function selectModel(provider, requested, settings) {
  if (!provider || !provider.url) throw new Error('未启用有效供应商，请在「模型配置」中明确启用供应商');
  const catalog = providerModels(provider);
  if (!catalog.length) throw new Error('当前供应商没有可用模型，请更新模型清单');
  if (requested !== undefined && requested !== null && requested !== '') {
    if (typeof requested !== 'string' || !catalog.includes(requested)) throw new Error('所选模型不在当前供应商清单中，请重新选择模型');
    return requested;
  }
  return [provider.defaultModel, settings && settings.model].find(m => catalog.includes(m)) || catalog[0];
}
module.exports = { activeProvider, providerModels, selectModel };
