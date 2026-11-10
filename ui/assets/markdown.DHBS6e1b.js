import{Qd as e,Td as t,Xr as n,Zr as r,id as i}from"./vendor.BtI69WEu.js";import{r as a}from"./query-devtools.DIz6FZCX.js";import{h as o}from"./tanstack-vendor.C7oK5bXW.js";var s=n=>{let r=a(),{onSuccess:s,onError:c,onMutate:l,...u}=n??{},d={mutationFn:t=>e.editArtifact(t),onMutate:async e=>(l&&await l(e),{previousMessages:{},updatedConversationId:null}),onError:(e,t,n)=>{c?.(e,t,n)},onSuccess:(e,n,a)=>{let o=!0,c=i=>{i&&r.setQueryData([t.messages,i],t=>{if(!t)return t;let r=[...t],i;for(let e=r.length-1;e>=0;e--)if(r[e].messageId===n.messageId){i=e,o=!1;break}return i==null?t:(r[i]={...r[i],content:e.content,text:e.text},r)})};c(e.conversationId),o&&(console.warn("Edited Artifact Message not found in cache, trying `new` as `conversationId`"),c(i.NEW_CONVO)),s?.(e,n,a)},...u};return o(d)},c=(n,r)=>{let i=a(),{onSuccess:s,onError:c,onMutate:l,...u}=r??{},d={mutationFn:t=>e.branchMessage(t),onMutate:async e=>(l&&await l(e),n&&await i.cancelQueries([t.messages,n]),{previousMessages:n?i.getQueryData([t.messages,n]):void 0,conversationId:n}),onError:(e,n,r)=>{r?.conversationId&&r?.previousMessages&&i.setQueryData([t.messages,r.conversationId],r.previousMessages),c?.(e,n,r)},onSuccess:(e,n,r)=>{let a=e.conversationId||r?.conversationId;a&&i.setQueryData([t.messages,a],t=>t?[...t,e]:[e]),s?.(e,n,r)},...u};return o(d)},l=new Set([`http:`,`https:`,`mailto:`,`tel:`]),u=e=>{let t=e.trim();if(!t)return!1;if(t.startsWith(`/`)||t.startsWith(`#`)||t.startsWith(`.`))return!0;try{return l.has(new URL(t).protocol)}catch{return!1}},d=`
/* GitHub Markdown CSS - Light theme base */
.markdown-body {
  -ms-text-size-adjust: 100%;
  -webkit-text-size-adjust: 100%;
  line-height: 1.5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  word-wrap: break-word;
  color: #24292f;
  background-color: #ffffff;
}

.markdown-body h1, .markdown-body h2 {
  border-bottom: 1px solid #d0d7de;
  margin: 0.6em 0;
}

.markdown-body h1 { font-size: 2em; margin: 0.67em 0; }
.markdown-body h2 { font-size: 1.5em; }
.markdown-body h3 { font-size: 1.25em; }
.markdown-body h4 { font-size: 1em; }
.markdown-body h5 { font-size: 0.875em; }
.markdown-body h6 { font-size: 0.85em; }

.markdown-body ul, .markdown-body ol {
  list-style: revert !important;
  padding-left: 2em !important;
  margin-top: 0;
  margin-bottom: 16px;
}

.markdown-body ul { list-style-type: disc !important; }
.markdown-body ol { list-style-type: decimal !important; }
.markdown-body ul ul { list-style-type: circle !important; }
.markdown-body ul ul ul { list-style-type: square !important; }

.markdown-body li { margin-top: 0.25em; }

.markdown-body li:has(> input[type="checkbox"]) {
  list-style-type: none !important;
}

.markdown-body li > input[type="checkbox"] {
  margin-right: 0.75em;
  margin-left: -1.5em;
  vertical-align: middle;
  pointer-events: none;
  width: 16px;
  height: 16px;
}

.markdown-body .task-list-item {
  list-style-type: none !important;
}

.markdown-body .task-list-item > input[type="checkbox"] {
  margin-right: 0.75em;
  margin-left: -1.5em;
  vertical-align: middle;
  pointer-events: none;
  width: 16px;
  height: 16px;
}

.markdown-body code {
  padding: 0.2em 0.4em;
  margin: 0;
  font-size: 85%;
  border-radius: 6px;
  background-color: rgba(175, 184, 193, 0.2);
  color: #24292f;
  font-family: ui-monospace, monospace;
  white-space: pre-wrap;
}

.markdown-body pre {
  padding: 16px;
  overflow: auto;
  font-size: 85%;
  line-height: 1.45;
  border-radius: 6px;
  margin-top: 0;
  margin-bottom: 16px;
  background-color: #f6f8fa;
  color: #24292f;
}

.markdown-body pre code {
  display: inline-block;
  padding: 0;
  margin: 0;
  overflow: visible;
  line-height: inherit;
  word-wrap: normal;
  background-color: transparent;
  border: 0;
}

.markdown-body a {
  text-decoration: none;
  color: #0969da;
}

.markdown-body a:hover {
  text-decoration: underline;
}

.markdown-body table {
  border-spacing: 0;
  border-collapse: collapse;
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
}

.markdown-body table thead {
  background-color: #f6f8fa;
}

.markdown-body table th, .markdown-body table td {
  padding: 6px 13px;
  border: 1px solid #d0d7de;
}

.markdown-body blockquote {
  padding: 0 1em;
  border-left: 0.25em solid #d0d7de;
  margin: 0 0 16px 0;
  color: #57606a;
}

.markdown-body hr {
  height: 0.25em;
  padding: 0;
  margin: 24px 0;
  border: 0;
  background-color: #d0d7de;
}

.markdown-body img {
  max-width: 100%;
  box-sizing: content-box;
}

/* Rendered in place of the document when the marked CDN does not load. Its own
   rule rather than an inline style so a contrast mode can reach it. */
.markdown-error {
  color: #e53e3e;
  padding: 1rem;
}

/* Dark theme */
@media (prefers-color-scheme: dark) {
  .markdown-body {
    color: #c9d1d9;
    background-color: #0d1117;
  }

  .markdown-body h1, .markdown-body h2 {
    border-bottom-color: #21262d;
  }

  .markdown-body code {
    background-color: rgba(110, 118, 129, 0.4);
    color: #c9d1d9;
  }

  .markdown-body pre {
    background-color: #161b22;
    color: #c9d1d9;
  }

  .markdown-body a {
    color: #58a6ff;
  }

  .markdown-body table thead {
    background-color: #161b22;
  }

  .markdown-body table th, .markdown-body table td {
    border-color: #30363d;
  }

  .markdown-body blockquote {
    border-left-color: #3b434b;
    color: #8b949e;
  }

  .markdown-body hr {
    background-color: #21262d;
  }
}

/* Scrollbar */
::-webkit-scrollbar { height: 0.1em; width: 0.5rem; }
::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,0.1); border-radius: 9999px; }
::-webkit-scrollbar-track { background-color: transparent; border-radius: 9999px; }
@media (prefers-color-scheme: dark) {
  ::-webkit-scrollbar-thumb { background-color: hsla(0,0%,100%,0.1); }
}
* { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.1) transparent; }
@media (prefers-color-scheme: dark) {
  * { scrollbar-color: hsla(0,0%,100%,0.1) transparent; }
}
`;function f(e){return e.replace(/\\/g,`\\\\`).replace(/`/g,"\\`").replace(/\$/g,`\\$`).replace(/<\/script/gi,`<\\/script`)}var p=`https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js`,m=`sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+`,h=`const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const isSafeUrl = (url) => {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('.')) return true;
  try { return SAFE_PROTOCOLS.has(new URL(trimmed).protocol); } catch(e) { return false; }
};`;function g(e){let t=e?n:r,i=(e,n)=>{let r=t[e]?.trim().split(/\s+/).map(Number);return r?.length!==3||r.some(Number.isNaN)?n:`#${r.map(e=>e.toString(16).padStart(2,`0`)).join(``)}`},a=i(`rgb-surface-primary`,e?`#000000`:`#ffffff`),o=i(`rgb-text-primary`,e?`#ffffff`:`#000000`),s=i(`rgb-link`,e?`#8cc8ff`:`#0000cc`),c=i(`rgb-border-medium`,o);return`
.markdown-body { color: ${o}; background-color: ${a}; }
body { background-color: ${a}; }
.markdown-body h1, .markdown-body h2 { border-bottom-color: ${c}; }
.markdown-body a, .markdown-body a:hover { color: ${s}; text-decoration: underline; }
.markdown-body table th, .markdown-body table td { border-color: ${c}; }
.markdown-body table thead { background-color: ${a}; }
.markdown-body blockquote { border-left-color: ${c}; color: ${o}; }
.markdown-body hr { background-color: ${c}; }
.markdown-body code, .markdown-body pre { color: ${o}; background-color: ${i(`rgb-surface-secondary`,a)}; }
.markdown-body pre { border: 1px solid ${c}; }
::-webkit-scrollbar-thumb { background-color: ${o}; }
* { scrollbar-color: ${o} ${a}; }
.markdown-error { color: ${i(`rgb-text-destructive`,e?`#ff8f8f`:`#a10000`)}; }
`}function _(e,t=``){return`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Markdown Preview</title>
<style>${d}${t}</style>
</head>
<body>
<div class="markdown-body" id="content" style="padding:2rem;margin:1rem;min-height:100vh"></div>
<script src="${p}" integrity="${m}" crossorigin="anonymous"><\/script>
<script>
if (typeof marked === 'undefined') {
  document.getElementById('content').innerHTML =
    '<p class="markdown-error">Markdown renderer failed to load. Check network connectivity.</p>';
} else {
${h}
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html() { return ''; },
    link(token) {
      if (!isSafeUrl(token.href || '')) return '';
      return false; // fall through to marked's default link renderer
    },
    image(token) {
      if (!isSafeUrl(token.href || '')) return '';
      return false; // fall through to marked's default image renderer
    }
  }
});
document.getElementById('content').innerHTML = marked.parse(\`${f(e.replace(/^( {2})(-|\d+\.)/gm,`    $2`))}\`);
}
<\/script>
</body>
</html>`}var v=(e,t=!1,n=!1)=>{let r=e||`# No content provided`;return{"content.md":r,"index.html":_(r,n?g(t):``)}};export{s as i,u as n,c as r,v as t};