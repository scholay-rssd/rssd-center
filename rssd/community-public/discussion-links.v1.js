/* Optional discussion metadata. One cached static request; never polls or edits content. */
(()=>{
  if(!/^\/(?:en\/)?(?:news|calendar|history|open-source)\/.+\/$/.test(location.pathname))return;
  const article=document.querySelector('main article.record-page, main article.article-page, main article.entry-detail, main article');
  if(!article||document.querySelector('[data-community-discussion]'))return;
  const sourceRoute=article.dataset.communitySourceRoute||location.pathname;
  if(!/^\/(?:news|calendar|history|open-source)\/.+\/$/.test(sourceRoute))return;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),2500);
  fetch('/community/links.json',{credentials:'omit',cache:'default',signal:controller.signal,referrerPolicy:'no-referrer'})
    .then(r=>r.ok?r.json():null).then(data=>{
      if(data?.version!==1||typeof data.links?.[sourceRoute]!=='string')return;
      const href=new URL(data.links[sourceRoute]);
      if(href.origin!=='https://enterscholar.com'||!/^\/t\/-\/\d+$/.test(href.pathname)||href.username||href.password||href.search||href.hash)return;
      const aside=document.createElement('aside'),p=document.createElement('p'),a=document.createElement('a');
      const english=document.documentElement.lang==='en';
      aside.dataset.communityDiscussion='';aside.className='interaction-link community-discussion';aside.setAttribute('aria-label',english?'Article discussion':'本文讨论');
      a.href=href.href;a.rel='noopener';a.textContent=english?'Discuss this article on EntScholar (Chinese) ↗':'到恩特讨论这篇文章 ↗';p.append(a);aside.append(p);article.append(aside);
    }).catch(()=>{}).finally(()=>clearTimeout(timeout));
})();
