/** Explicit primary-API desktop/mobile reader acceptance; no intercepted browser requests. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { withEmptyCorpus, writeSeedCorpus } from "./helpers/output-root.ts";
import { withOutputRoot } from "../src/shared/paths.ts";
import { handleApiRoute } from "../src/gui/routes.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";
import { llmConfig } from "../src/llm/config.ts";
import { addDocuments } from "../src/llm/chroma.ts";
import type { ArticlePage } from "../src/types.ts";
export async function runReaderJourneys() {
  return withEmptyCorpus(async root => {
    await writeSeedCorpus(root, {articleCount:6});
    const seed = await Bun.file("pages-data/crescent-city-code.json").json() as {articles:ArticlePage[]};
    const first = seed.articles.slice(0,6).flatMap(row=>row.sections).find(row=>row.text.trim())!;
    const backend = llmHttpFixture(), prior={...llmConfig}; llmConfig.chromaUrl=backend.url;llmConfig.ollamaUrl=backend.url;llmConfig.provider="ollama";
    const sections = seed.articles.slice(0,6).flatMap(row=>row.sections).filter(row=>row.text.trim()).slice(0,8);
    await addDocuments({ids:sections.map(s=>s.guid),documents:sections.map(s=>s.text),embeddings:sections.map((s,i)=>[s.text.length/100,i+1,(i+1)**2]),metadatas:sections.map(s=>({sectionGuid:s.guid,sectionNumber:s.number,sectionTitle:s.title,articleTitle:'Reviewed seed fixture'}))});
    let delayed = false, failing = false, delayedReached = 0, delaySummary = false, summaryReached = 0;
    const calls: Array<{path:string;status:number}> = [];
    const server = Bun.serve({port:0, async fetch(req) {
      const url=new URL(req.url);
      if(url.pathname.startsWith('/api/')) {
        if(url.pathname==='/api/lexicon/frequency'&&delayed){delayedReached++;await Bun.sleep(900);}
        if(url.pathname==='/api/lexicon/frequency'&&failing)return Response.json({error:'Fixture reader unavailable'},{status:503});
        if(url.pathname==='/api/summarize'&&delaySummary){summaryReached++;await Bun.sleep(900);}
        const response=await withOutputRoot(root,()=>handleApiRoute(url,req));calls.push({path:url.pathname,status:response.status});return response;
      }
      const path=resolve('src/gui/static',url.pathname==='/'?'index.html':url.pathname.slice(1));
      return path.startsWith(resolve('src/gui/static')+'/')&&existsSync(path)?new Response(Bun.file(path)):new Response('Not found',{status:404});
    }});
    const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{})}); let passed=0;
    try {
      for(const width of [1280,390]) {
        const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);
        const errors:string[]=[],external:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(`http://127.0.0.1:${server.port}`))external.push(r.url());});
        await page.goto(`http://127.0.0.1:${server.port}`,{waitUntil:'domcontentloaded'});await page.locator('html[data-reader-ready=true]').waitFor();
        for(const section of ['analytics','feeds','sources','dev']) {
          await page.locator(`#${section}-toggle`).click();
          assert.equal(await page.locator(`#${section}-toggle`).getAttribute('aria-expanded'),'true');
          const tabs=await page.locator(`#${section}-overlay .intel-tab`).evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).dataset.tab!));
          for(const tab of tabs) {
            await page.locator(`#${section}-overlay .intel-tab[data-tab="${tab}"]`).click();
            if(tab==='history'){await page.locator('#history-guid-input').fill(first.guid);await page.locator('#history-load-btn').click();}
            if(tab==='compare'){await page.locator('#compare-guid1').fill(first.guid);await page.locator('#compare-guid2').fill(first.guid);await page.locator('#compare-btn').click();}
            await page.waitForFunction(id=>!document.getElementById(`intel-${id}`)?.querySelector('[aria-busy="true"]'),tab);
            const panel=page.locator(`#intel-${tab}`);assert.equal(await panel.isVisible(),true);
            const text = (await panel.textContent())!.trim(); assert.equal(text.length>0,true,`${width}/${tab} empty reader`); assert.equal(/Failed to build|Could not load|Failed to reach|This reader could not load/.test(text),false,`${width}/${tab} failed reader: ${text.slice(0,180)}`);
            assert.equal(await page.locator(`#${section}-overlay .intel-tab[data-tab="${tab}"]`).getAttribute('aria-selected'),'true');passed++;
          }
          const tab=page.locator(`#${section}-overlay .intel-tab[aria-selected=true]`);await tab.focus();await page.keyboard.press('Home');
          assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-selected')),'true');await page.keyboard.press('Escape');
          assert.equal(await page.locator(`#${section}-toggle`).getAttribute('aria-expanded'),'false');assert.equal(await page.evaluate(()=>document.activeElement?.id),`${section}-toggle`);passed++;
        }
        await page.locator('#alerts-toggle').click();await page.waitForFunction(()=>![...document.querySelectorAll('#alerts-panel [aria-busy]')].some(n=>n.getAttribute('aria-busy')==='true'));
        assert.equal(await page.locator('#alerts-content strong').count(),20); assert.equal((await page.locator('#alerts-content').textContent())!.includes('No data yet'),true);await page.keyboard.press('Escape');passed++;
        // Percentage anchors are layout positions, and are usable without a pointer.
        await page.locator('#alerts-toggle').click();await page.locator('#annotation-list[aria-busy=false]').waitFor();
        await page.locator('#annotation-x').fill('25');await page.locator('#annotation-y').fill('75');await page.locator('#annotation-anchor').focus();await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(()=>document.activeElement?.id),'annotation-text');await page.locator('#annotation-text').fill('Local keyboard fixture note');await page.locator('#annotation-save').click();
        await page.locator('#annotation-list [data-delete-annotation]').waitFor();assert.equal((await page.locator('#annotation-list').textContent())!.includes('Local keyboard fixture note'),true);
        await page.locator('#annotation-list [data-delete-annotation]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('annotation-list')?.textContent?.includes('No annotations yet'));await page.keyboard.press('Escape');passed++;
        // The primary projection API populates a keyboard section picker, including coordinate caveats.
        await page.locator('#analytics-toggle').click();await page.locator('[data-tab=stats]').click();await page.locator('#pca-section').waitFor();
        assert.equal(await page.locator('#pca-section option').count(),sections.length);assert.equal((await page.locator('#pca-section-values').textContent())!.includes('do not establish legal similarity'),true);
        await page.locator('#pca-open-section').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('content')?.textContent?.includes('Summarize'));passed++;
        delaySummary=true;await page.locator('#content .summarize-btn').first().click();await page.waitForFunction(()=>document.querySelector('#content [id^=summary-][aria-busy]')?.getAttribute('aria-busy')==='true');
        await page.locator('#content [id$="-request-controls"] button').first().click();await page.waitForFunction(()=>document.querySelector('#content [id^=summary-][data-request-state=cancelled]'));
        await page.waitForTimeout(1000);assert.equal((await page.locator('#content').textContent())!.includes('Loading cancelled'),true);assert.equal(summaryReached>0,true);delaySummary=false;
        await page.locator('#content [id$="-request-controls"] button').first().click();await page.waitForFunction(()=>document.querySelector('#content [id^=summary-][data-request-state=settled]'));
        assert.equal((await page.locator('#content').textContent())!.includes('Generated by'),true);passed++;
        const download = page.waitForEvent('download');await page.locator('#content [data-action=export]').focus();await page.keyboard.press('Enter');assert.equal((await download).suggestedFilename().endsWith('.md'),true);await page.locator('#content [id^=export-][aria-busy=false]').waitFor({state:'attached'});assert.equal((await page.locator('#content').textContent())!.includes('Markdown download requested'),true);assert.equal(await page.locator('#content').evaluate(node=>node.getBoundingClientRect().width>Math.min(300,innerWidth*0.6)),true,'code reader retains readable width with status controls');passed++;
        // Latest ownership and a visible retry: a delayed old response cannot replace cancellation.
        delayed=true;await page.locator('#analytics-toggle').click();await page.locator('[data-tab="lexicon"]').click();
        await page.waitForFunction(()=>document.getElementById('lexicon-content')?.getAttribute('aria-busy')==='true');
        await page.locator('#lexicon-content-request-controls button').click();await page.locator('#lexicon-content[data-request-state=cancelled]').waitFor();
        await page.waitForTimeout(1000);assert.equal((await page.locator('#lexicon-content').textContent())!.includes('cancelled'),true);assert.equal(delayedReached>0,true);
        delayed=false;await page.locator('#lexicon-content-request-controls button').click();await page.locator('#lexicon-content[data-request-state=settled]').waitFor();passed++;
        failing=true;await page.locator('#lexicon-content-request-controls button').click();await page.locator('#lexicon-content[aria-busy=false]').waitFor();assert.equal((await page.locator('#lexicon-content').textContent())!.includes('unavailable'),true);failing=false;await page.locator('#lexicon-content-request-controls button').click();await page.locator('#lexicon-content[aria-busy=false]').waitFor();assert.equal((await page.locator('#lexicon-content').textContent())!.includes('Fixture reader unavailable'),false);passed++;
        console.log(JSON.stringify(await page.evaluate(()=>{const button=document.getElementById('dev-toggle')!.getBoundingClientRect();return {readerNavigationLayout:{width:innerWidth,headerBottom:document.getElementById('header')!.getBoundingClientRect().bottom,overlayTop:document.getElementById('analytics-overlay')!.getBoundingClientRect().top,buttonTop:button.top,buttonBottom:button.bottom,hit:document.elementFromPoint(button.x+button.width/2,button.y+button.height/2)?.id}};})));
        await page.locator('#dev-toggle').click();await page.locator('[data-tab=api]').click();await page.locator('.api-explorer-btn[data-path="/api/stats"]').focus();await page.keyboard.press('Enter');await page.locator('#api-explorer-result[aria-busy=false]').waitFor();assert.equal((await page.locator('#api-explorer-result').textContent())!.startsWith('200'),true);passed++;
        await page.keyboard.press('Escape');
        for(const standalone of ['structured-queries','phase10-legal','docs-dashboard']) {
          await page.goto(`http://127.0.0.1:${server.port}/${standalone}.html`,{waitUntil:'domcontentloaded'});await page.locator('html[data-reader-ready=true]').waitFor();
          if(standalone==='structured-queries') {
            for(const [input,button,target]of [['history-guid','history-load','history-content'],['similar-guid','similar-run','similar-result']]){await page.locator('#'+input).fill(first.guid);await page.locator('#'+input).press('Enter');await page.locator(`#${target}[aria-busy=false]`).waitFor();passed++;}
            await page.locator('#compare-guid1').fill(first.guid);await page.locator('#compare-guid2').fill(first.guid);await page.locator('#compare-run').click();await page.locator('#compare-result[aria-busy=false]').waitFor();assert.equal((await page.locator('#compare-result').textContent())!.includes('Similarity'),true);passed++;
          } else if(standalone==='phase10-legal') {
            for(const [button,target]of [['ordinals-load','ordinals-content'],['crosslinks-load','crosslinks-content'],['effective-load','effective-content']]){await page.locator('#'+button).click();await page.locator(`#${target}[aria-busy=false]`).waitFor();passed++;}
          } else {await page.locator('#dashboard-content[aria-busy=false]').waitFor();assert.equal((await page.locator('#dashboard-summary').textContent())!.includes('modules'),true);passed++;}
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`${width}/${standalone} horizontal viewport overflow`);
        }
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await context.close();
      }
      console.log(JSON.stringify({nativeReaderJourneys:passed,primaryApiResponses:calls.length,viewportWidths:[1280,390],providerCalls:'local protocol fixture only',semanticSupport:'unassessed'}));
    } finally {await browser.close();server.stop(true);backend.server.stop(true);Object.assign(llmConfig,prior);}
  });
}
if(import.meta.main)await runReaderJourneys();
