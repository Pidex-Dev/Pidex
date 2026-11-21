import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExternalFontService, extractSafeWoff2Paths } from '../src/settings/ExternalFontService.js'

const createdDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pidex-external-fonts-'))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ExternalFontService', () => {
  test('extractSafeWoff2Paths filters out unsafe or duplicate paths', () => {
    const css = `
      @font-face { src: url(./files/google-sans-latin-wght-normal.woff2) format('woff2-variations'); }
      @font-face { src: url(./files/google-sans-latin-wght-normal.woff2) format('woff2-variations'); }
      @font-face { src: url(./files/../secret.woff2); }
      @font-face { src: url(https://evil.example/a.woff2); }
    `
    expect(extractSafeWoff2Paths(css)).toEqual(['files/google-sans-latin-wght-normal.woff2'])
  })

  test('downloads external font to userData/fonts and builds inline CSS', async () => {
    const root = makeTempDir()
    const fakeWoff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x01, 0x02])
    const fakeCss = `
      @font-face {
        font-family: 'Google Sans Variable';
        font-style: normal;
        font-weight: 400 700;
        src: url(./files/google-sans-latin-wght-normal.woff2) format('woff2-variations');
      }
    `
    const fetchFn: typeof fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith('/index.css')) {
        return new Response(fakeCss, { status: 200 })
      }
      if (url.endsWith('/files/google-sans-latin-wght-normal.woff2')) {
        return new Response(fakeWoff2, { status: 200 })
      }
      return new Response('Not Found', { status: 404 })
    }) as typeof fetch

    const service = new ExternalFontService({ rootDirectory: root, fetchFn })
    const initialStates = await service.listStates()
    expect(initialStates.find((s) => s.id === 'google-sans')?.status).toBe('not-downloaded')

    const result = await service.downloadFont('google-sans')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.status).toBe('downloaded')
    expect(result.css).toContain("font-family: 'Google Sans'")
    expect(result.css).toContain('data:font/woff2;base64,')

    const afterStates = await service.listStates()
    expect(afterStates.find((s) => s.id === 'google-sans')?.status).toBe('downloaded')

    // Corrupted/missing font file causes fallback to not-downloaded and null CSS
    await writeFile(join(root, 'google-sans', 'files', 'google-sans-latin-wght-normal.woff2'), '')
    expect(await service.getFontCss('google-sans')).toBeNull()
    const corruptedStates = await service.listStates()
    expect(corruptedStates.find((s) => s.id === 'google-sans')?.status).toBe('not-downloaded')
  })

  test('downloads multi-CSS-entry font (misans) resolving relative woff2 paths', async () => {
    const root = makeTempDir()
    const fakeWoff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x03, 0x04])
    const fetchFn: typeof fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith('/lib/Normal/MiSans-Regular.min.css')) {
        return new Response(
          `@font-face{font-family:MiSans;font-weight:330;src:url('MiSans-Regular.5.woff2') format('woff2');}`,
          { status: 200 },
        )
      }
      if (
        url.endsWith('/lib/Normal/MiSans-Medium.min.css') ||
        url.endsWith('/lib/Normal/MiSans-Demibold.min.css') ||
        url.endsWith('/lib/Normal/MiSans-Bold.min.css')
      ) {
        return new Response(
          `@font-face{font-family:MiSans;font-weight:500;src:url('MiSans-Medium.5.woff2') format('woff2');}`,
          { status: 200 },
        )
      }
      if (
        url.endsWith('/lib/Normal/MiSans-Regular.5.woff2') ||
        url.endsWith('/lib/Normal/MiSans-Medium.5.woff2')
      ) {
        return new Response(fakeWoff2, { status: 200 })
      }
      return new Response('Not Found', { status: 404 })
    }) as typeof fetch

    const service = new ExternalFontService({ rootDirectory: root, fetchFn })
    const result = await service.downloadFont('misans')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.css).toContain("font-family: 'MiSans'")
    expect(result.css).toContain('data:font/woff2;base64,')
  })
})
