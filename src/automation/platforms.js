const store = require('./store');
const browser = require('./browser');
const { PLATFORMS } = require('./companies');
function sessionStatus(name, facts) {
  if (facts.challenge) return 'verification_required';
  if (facts.loginVisible || /\/login|\/signin|\/authwall|\/checkpoint/i.test(facts.url)) return 'login_required';
  if (name.toLowerCase() === 'naukri' && facts.accountControls?.some(control => /^(?:open profile menu|my naukri|view profile|my profile)$/i.test(control.label.trim()))) return 'authenticated';
  if (facts.accountMarker) return 'authenticated';
  return 'unverified';
}
async function inspect(onlyName) {
  const results = store.read('platform-status', []);
  const selected = PLATFORMS.filter(platform => !onlyName || platform.name.toLowerCase() === String(onlyName).toLowerCase());
  if (onlyName && !selected.length) throw new Error('Unknown job platform');
  const save = result => {
    const index = results.findIndex(item => item.name === result.name);
    if (index < 0) results.push(result); else results[index] = result;
    store.write('platform-status', results);
  };
  for (const platform of selected) {
    let page;
    if (!platform.url) { save({ name: platform.name, status: 'url_required', checkedAt: new Date().toISOString(), note: platform.note, mode: platform.mode }); continue; }
    try {
      // Reuse the signed-in interactive persistent context opened by the dashboard.
      page = await browser.open(platform.url, { interactive: true });
      await page.waitForTimeout(2000);
      const facts = await page.evaluate(() => {
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const text = document.body.innerText;
        const controls = [...document.querySelectorAll('a,button')].filter(visible);
        return {
          url: location.href,
          challenge: /verify you are human|access denied|checking your browser|unusual activity|security verification/i.test(text) || [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenges.cloudflare"]')].some(visible) || (text.trim().length < 200 && !!document.querySelector('script[src*="captcha-delivery"]')),
          loginVisible: [...document.querySelectorAll('input[type="password"]')].some(visible),
          accountMarker: controls.some(el => /^(?:log\s*out|sign\s*out|view profile|edit profile|my profile|my applications)$/i.test(el.innerText.trim()) || /\/in\/[^/]+\/?$|\/mnjuser\/profile|\/candidate\/profile\/|^\/(?:profile|my-applications)\/?$/.test(el.getAttribute('href') || '')),
          accountControls: controls.filter(el => /login|log out|logout|profile|applications/i.test(el.innerText || el.getAttribute('aria-label') || '')).slice(0,12).map(el => ({ label: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0,80), path: el.getAttribute('href')?.split('?')[0] })),
          localSessionKeys: Object.keys(localStorage).filter(k => /token|auth|user|session/i.test(k)),
          jobs: controls.filter(el => /\/jobs\/view\/|job-listings|\/job\/[\w-]+|\/opportunities\/\d+/i.test(el.getAttribute('href') || '')).slice(0,30).map(el => ({ title: el.innerText.trim().slice(0,150), url: el.href })).filter(j => j.title && j.url)
        };
      });
      const status = sessionStatus(platform.name, facts);
      save({ name: platform.name, status, checkedAt: new Date().toISOString(), url: facts.url.split('?')[0], mode: 'manual', discoveredLinks: facts.jobs, accountControls: facts.accountControls, localSessionKeys: facts.localSessionKeys, note: 'Read-only live session check; unattended submission has not been verified' });
      store.event(`${platform.name}: live session ${status}; ${facts.jobs.length} visible job links`);
    } catch (error) {
      save({ name: platform.name, status: 'check_failed', checkedAt: new Date().toISOString(), mode: 'manual', note: error.message.split('\n')[0] });
      store.event(`${platform.name}: live session check failed`);
    } finally { if (page) await page.close().catch(() => {}); }
  }
  return results;
}
module.exports = { inspect, sessionStatus };
