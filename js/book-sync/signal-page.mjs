import {installSignalFacade} from './signal-facade.mjs';
import {signalText} from './signal-text.mjs';
const query=new URLSearchParams(location.search),want=query.get('lang'),lang=Object.hasOwn(signalText,want)?want:'en',theme=query.get('theme');document.documentElement.lang=lang;if(['light','dark'].includes(theme))document.documentElement.dataset.theme=theme;
for(const p of document.querySelectorAll('[data-copy]'))p.textContent=signalText[lang][Number(p.dataset.copy)];
try{installSignalFacade({window,document});}catch{document.querySelector('[data-copy="0"]').textContent=signalText[lang][3];}
