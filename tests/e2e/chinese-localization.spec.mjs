import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

const project='/projects/e2e-ready';
const routes=['/projects','/agent','/tasks','/health-center','/settings/ai','/douyin-ops',
  ...['douyin','smart','product','truth','research','reference-video','creative-references','creative','script','director','generate','single-video','auto-edit','models','timeline','final','publish-settings'].map(path=>project+'/'+path),'/publish/mobile/test-package'];

test('all 24 user pages serve Chinese controls on desktop and mobile without changing option values',async({page})=>{
  test.setTimeout(420000);
  const leftovers=[];
  const englishControls=[];
  for(const size of [{width:1366,height:768},{width:390,height:844}]){
    await page.setViewportSize(size);
    for(const route of routes){
      await test.step(`${size.width} ${route}`,async()=>{
        const response=await page.goto(route,{waitUntil:'domcontentloaded'});
        expect(response.status(),route).toBe(200);
        await expect(page.locator('script[data-pvs-locale="zh-CN"]')).toHaveCount(1);
        const labels=await page.locator('button,option,label,h1,h2,h3,summary').evaluateAll(nodes=>nodes
          .filter(node=>!node.closest('pre,code,.technical,[data-pvs-preserve-text]'))
          .map(node=>node.textContent.trim()).filter(Boolean));
        for(const label of labels){
          if(/[A-Za-z]/.test(label)&&!/[\u3400-\u9fff]/.test(label))englishControls.push({route,width:size.width,label:label.slice(0,180)});
          if(/^(HARD|SOFT|NONE|DIALOGUE|NARRATION|AMBIENT|HOOK|PAIN|CTA|LOW|MEDIUM|HIGH|PENDING|SUBMITTED|CONFIRMED|UNKNOWN|AUTO|PASS|BLOCKED)$/.test(label)) leftovers.push({route,width:size.width,label});
          if(/\b(?:Product Truth|Production Plan|Preflight|WorkflowBlocker|GenerationAttempt|Prompt Inspector|Continuity In|Continuity Out)\b/.test(label)) leftovers.push({route,width:size.width,label:label.slice(0,180)});
        }
        const title=await page.title();expect(title,route).not.toContain('Product Video Studio');
        if(size.width<400){const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);expect(overflow,route).toBeLessThanOrEqual(2);}
      });
    }
  }
  expect(leftovers).toEqual([]);
  await fs.mkdir('.runtime',{recursive:true});
  await fs.writeFile('.runtime/ui-english-audit.json',JSON.stringify(englishControls,null,2));
});

test('dynamic options get Chinese labels while values stay compatible',async({page})=>{
  await page.goto(project+'/script');
  const purposes=page.locator('select.beat-purpose');
  if(await purposes.count()){
    const select=purposes.first();
    await expect(select.locator('option[value="CTA"]')).toHaveText('引导用户行动（如咨询、购买）');
    await select.selectOption('CTA');await expect(select).toHaveValue('CTA');
  }
  await page.evaluate(()=>{
    const select=document.createElement('select');select.id='locale-dynamic-probe';
    select.innerHTML='<option value="DIALOGUE">DIALOGUE</option><option value="HARD_CONTINUITY">HARD_CONTINUITY</option>';
    document.body.append(select);
  });
  const select=page.locator('#locale-dynamic-probe');
  await expect(select.locator('option[value="DIALOGUE"]')).toHaveText('人物对白');
  await expect(select.locator('option[value="HARD_CONTINUITY"]')).toHaveText('强连续：必须承接上一片段');
  await select.selectOption('HARD_CONTINUITY');await expect(select).toHaveValue('HARD_CONTINUITY');
});
