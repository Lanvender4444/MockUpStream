import * as oai from './formats/openai.js';
import * as gem from './formats/gemini.js';
// 手动设了图片输入 40 的情况
const c = { imageEnabled:1, imageInputTokens:40, imageOutputTokens:1120, promptMode:'fixed', promptTokens:100, completionTokens:1557, cacheMode:'none', content:'x' };
console.log('openai chat prompt_tokens_details :', JSON.stringify(oai.buildResponse(c,[],'m').usage.prompt_tokens_details));
console.log('gemini promptTokensDetails        :', JSON.stringify(gem.buildResponse(c,[],'m').usageMetadata.promptTokensDetails));
// 图片输入=0 的情况(默认种子)
const z = { imageEnabled:1, imageInputTokens:0, imageOutputTokens:1120, promptMode:'fixed', promptTokens:100, completionTokens:1557, cacheMode:'none', content:'x' };
console.log('imageInput=0 openai              :', JSON.stringify(oai.buildResponse(z,[],'m').usage.prompt_tokens_details));
