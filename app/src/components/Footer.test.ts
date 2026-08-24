// @ts-expect-error Vitest runs in Node; the browser app intentionally does not load global Node typings.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const POLICE_FILING = '京公网安备11010802049879号';
const POLICE_RECORD_URL = 'http://www.beian.gov.cn/portal/registerSystemInfo?recordcode=11010802049879';

const footerUrl = new URL('./Footer.tsx', import.meta.url);
const stylesUrl = new URL('../styles.css', import.meta.url);
const landingUrl = new URL('./Landing.tsx', import.meta.url);
const authUrl = new URL('./Auth.tsx', import.meta.url);
const appUrl = new URL('../App.tsx', import.meta.url);
const envExampleUrl = new URL('../../../.env.production.example', import.meta.url);
const mainPoliceIconUrl = new URL('../../public/beian-police.png', import.meta.url);
const stephenPoliceIconUrl = new URL('../../stephen/public/beian-police.png', import.meta.url);

function readRequiredFile(url: URL) {
  const exists = existsSync(url);
  expect(exists, `missing ${url.pathname}`).toBe(true);
  return exists ? readFileSync(url, 'utf8') : '';
}

function readPngDimensions(url: URL) {
  const png = readFileSync(url);
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

describe('public security filing footer', () => {
  it('records the exact non-secret production filing configuration', () => {
    const envExample = readRequiredFile(envExampleUrl);

    expect(envExample).toContain('VITE_BEIAN_MODE=0');
    expect(envExample).toContain('VITE_ICP_BEIAN=京ICP备2026046195号-2');
    expect(envExample).toContain(`VITE_POLICE_BEIAN=${POLICE_FILING}`);
    expect(envExample).toContain(`VITE_POLICE_BEIAN_URL=${POLICE_RECORD_URL}`);
  });

  it('covers the public landing page, login and authenticated CRM with the shared Footer', () => {
    const footer = readRequiredFile(footerUrl);
    const styles = readRequiredFile(stylesUrl);
    const landing = readRequiredFile(landingUrl);
    const auth = readRequiredFile(authUrl);
    const app = readRequiredFile(appUrl);

    expect(footer).toContain('src="/beian-police.png"');
    expect(footer).toContain('alt=""');
    expect(footer).toContain('className="beian-police-link"');
    expect(footer).toContain('className="beian-police-icon"');
    expect(footer).toContain('target="_blank"');
    expect(footer).toContain('rel="noreferrer noopener"');
    expect(footer).toContain('POLICE_URL');
    expect(styles).toMatch(/\.beian-police-link\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*5px;/s);
    expect(styles).toMatch(/\.beian-police-icon\s*\{[^}]*width:\s*auto;[^}]*height:\s*20px;/s);
    expect(landing).toContain('<Footer />');
    expect(auth).toContain('<Footer />');
    expect(app.match(/<Footer \/>/g)).toHaveLength(3);
  });

  it('publishes the unchanged 36 by 40 local icon in both build roots', () => {
    expect(existsSync(mainPoliceIconUrl)).toBe(true);
    expect(existsSync(stephenPoliceIconUrl)).toBe(true);
    expect(readPngDimensions(mainPoliceIconUrl)).toEqual({ width: 36, height: 40 });
    expect(readPngDimensions(stephenPoliceIconUrl)).toEqual({ width: 36, height: 40 });
  });
});
