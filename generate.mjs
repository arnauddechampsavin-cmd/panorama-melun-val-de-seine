
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';
import path from 'node:path';

// =====================================================
// PANORAMA TERRITORIAL - MELUN VAL DE SEINE
// VERSION 5E - CORRECTION DE LA PAGINATION
// =====================================================

const URL =
  'https://data.melunvaldeseine.fr/pages/test-pano-arnaud/';

const OUT = 'output';
const TIMEOUT = 60000;

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true
});

const report = [];

// =====================================================
// 1. OUVERTURE DE HUWISE
// =====================================================

async function preparePage() {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1
  });

  page.setDefaultTimeout(TIMEOUT);

  await page.goto(URL, {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  });

  await page.locator(
    '.sidebar-nav .cl-dropdown'
  ).first().waitFor({ state: 'attached' });

  await page.addStyleTag({
    content: `
      ods-manage-cookies-preferences-modal,
      .ods-manage-cookies-preferences,
      .modal-backdrop {
        display: none !important;
        pointer-events: none !important;
      }
    `
  });

  return page;
}

// =====================================================
// 2. UTILITAIRES
// =====================================================

function slug(value) {
  return value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 55);
}

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =====================================================
// 3. NAVIGATION ANGULARJS
// =====================================================

async function selectSection(page, groupIndex, itemIndex) {
  const group = page
    .locator('.sidebar-nav .cl-dropdown')
    .nth(groupIndex);

  const button = group.locator('.cl-dropdown-button');

  const item = group
    .locator('.cl-dropdown-item')
    .nth(itemIndex);

  const ngClick = await item.getAttribute('ng-click');

  const match = ngClick?.match(
    /activeSubmenu\s*=\s*['"]([^'"]+)['"]/
  );

  if (!match) {
    throw new Error('Identifiant de rubrique introuvable');
  }

  const submenuId = match[1];

  console.log(`Selection : ${submenuId}`);

  const sectionVisible = async () => {
    return page.evaluate(expected => {
      return [
        ...document.querySelectorAll(
          '.content-area .content-section'
        )
      ].some(section =>
        (section.getAttribute('ng-if') || '')
          .includes(expected) &&
        section.getBoundingClientRect().height > 0
      );
    }, submenuId);
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await sectionVisible()) {
      console.log(`Section affichee : ${submenuId}`);
      return;
    }

    console.log(`Tentative ${attempt}/3 : ${submenuId}`);

    const isOpen = await button.evaluate(el =>
      el.classList.contains('cl-dropdown-button-open')
    );

    if (!isOpen) {
      await button.click();
    }

    await page.waitForFunction(index => {
      const group = document.querySelectorAll(
        '.sidebar-nav .cl-dropdown'
      )[index];

      return group?.querySelector(
        '.cl-dropdown-menu'
      )?.classList.contains('cl-dropdown-visible');
    }, groupIndex, { timeout: 10000 });

    await item.click({ timeout: 15000 });

    try {
      await page.waitForFunction(expected => {
        return [
          ...document.querySelectorAll(
            '.content-area .content-section'
          )
        ].some(section =>
          (section.getAttribute('ng-if') || '')
            .includes(expected) &&
          section.getBoundingClientRect().height > 0
        );
      }, submenuId, { timeout: 8000 });

      console.log(`Section affichee : ${submenuId}`);
      return;

    } catch (error) {
      console.warn(
        `Selection non confirmee : tentative ${attempt}`
      );

      await page.waitForTimeout(1000);
    }
  }

  throw new Error(
    `Impossible d'afficher ${submenuId} apres 3 tentatives`
  );
}

// =====================================================
// 4. CHARGEMENT DES VISUALISATIONS
// =====================================================

async function waitForVisuals(page) {
  const section = page.locator(
    '.content-area .content-section:visible'
  ).first();

  await section.waitFor({
    state: 'visible',
    timeout: 30000
  });

  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  await page.evaluate(async () => {
    const elements = [
      ...document.querySelectorAll(
        '.content-section .chart-section, ' +
        '.content-section .map-container'
      )
    ];

    for (const element of elements) {
      element.scrollIntoView({
        block: 'center',
        behavior: 'instant'
      });

      await new Promise(resolve =>
        setTimeout(resolve, 700)
      );
    }
  });

  await section.scrollIntoViewIfNeeded();

  await page.evaluate(async () => {
    await Promise.all(
      [...document.images].map(img => {
        if (img.complete) return Promise.resolve();

        return new Promise(resolve => {
          const finish = () => resolve();

          img.addEventListener('load', finish, {
            once: true
          });

          img.addEventListener('error', finish, {
            once: true
          });

          setTimeout(finish, 8000);
        });
      })
    );
  });

  await page.waitForFunction(() => {
    const charts = document.querySelectorAll(
      '.content-section ods-chart'
    );

    return [...charts].every(chart =>
      chart.querySelector('.highcharts-container')
    );
  }, null, { timeout: 15000 }).catch(() => {
    console.warn(
      'Certains graphiques ne sont pas confirmes'
    );
  });

  await page.waitForTimeout(3500);

  console.log('Visualisations preparees');
}

// =====================================================
// 5. GENERATION PDF - VERSION 5E
// =====================================================

async function printSection(page, file) {
  const section = page.locator(
    '.content-area .content-section:visible'
  ).first();

  await section.waitFor({ state: 'visible' });

  const title = await section.locator(
    '.section-title'
  ).first().innerText();

  const source = await section.locator(
    '.kpi-description'
  ).first().innerText().catch(() => '');

  const themeClass =
    await section.getAttribute('class') || '';

  let themeColor = '#015ca2';

  if (themeClass.includes('theme-demographie')) {
    themeColor = '#e79995';
  }

  if (themeClass.includes('theme-emploi')) {
    themeColor = '#0d47b3';
  }

  if (themeClass.includes('theme-logement')) {
    themeColor = '#3a8ba9';
  }

  if (themeClass.includes('theme-entreprises')) {
    themeColor = '#8a6ea9';
  }

  // Gabarits specifiques aux deux rubriques
  // qui debordaient dans la version 5D.

  const isSenior =
    /population s[eé]nior/i.test(title);

  const isActive =
    /population active et inactive/i.test(title);

  const isCompact = isSenior || isActive;

  // -------------------------------------------------
  // 5A. EXTRACTION DES BLOCS
  // -------------------------------------------------

  const blocks = section.locator(
    '.cards-grid, .chart-section, .map-section'
  );

  const elements = [];

  const count = await blocks.count();

  for (let i = 0; i < count; i++) {
    const block = blocks.nth(i);

    const nested = await block.evaluate(el =>
      !!el.parentElement.closest(
        '.cards-grid, .chart-section, .map-section'
      )
    );

    if (nested) continue;

    const box = await block.boundingBox();

    if (!box || box.height < 5) continue;

    const isCards = await block.evaluate(el =>
      el.classList.contains('cards-grid')
    );

    const specialEnterprise =
      /formes juridiques|familles d.activit/i.test(title);

    if (isCards && !specialEnterprise) {
      const cards = await block.locator(
        ':scope > .card'
      ).evaluateAll(nodes =>
        nodes.map(card => ({
          html: card.innerHTML,
          textLength: card.innerText.trim().length
        }))
      );

      if (cards.length) {
        elements.push({
          type: 'cards',
          cards
        });
      } else {
        elements.push({
          type: 'text',
          html: await block.innerHTML()
        });
      }

    } else {
      await block.scrollIntoViewIfNeeded();

      await page.waitForTimeout(
        specialEnterprise ? 700 : 400
      );

      const image = await block.screenshot({
        type: 'png',
        animations: 'disabled',
        scale: 'device',
        timeout: 30000
      });

      elements.push({
        type: 'visual',
        image: image.toString('base64'),
        width: box.width,
        height: box.height,
        ratio: box.width / box.height,
        kind: isCards ? 'indicators' : 'chart'
      });
    }
  }

  console.log(
    `${title} : ${elements.length} blocs prepares`
  );

  // -------------------------------------------------
  // 5B. CONSTRUCTION DU HTML
  // -------------------------------------------------

  const renderCards = element => `
    <div class="pdf-cards">
      ${element.cards.map(card => {
        const isLong = card.textLength > 240;

        return `
          <div class="pdf-card ${isLong ? 'pdf-card-long' : ''}">
            ${card.html}
          </div>
        `;
      }).join('')}
    </div>
  `;

  const renderInformation = element => {
    if (element.type === 'cards') {
      return renderCards(element);
    }

    return `
      <div class="pdf-text">
        ${element.html}
      </div>
    `;
  };

  const renderVisual = element => `
    <figure class="pdf-visual">
      <img
        src="data:image/png;base64,${element.image}"
        alt="Visualisation territoriale"
      >
    </figure>
  `;

  const information = elements.filter(
    el => el.type === 'cards' || el.type === 'text'
  );

  const visuals = elements.filter(
    el => el.type === 'visual'
  );

  const infoHTML = information
    .map(renderInformation)
    .join('');

  const complexVisual = visuals.some(
    el => el.ratio < 1.15 || el.height > 750
  );

  let content = '';

  // -------------------------------------------------
  // 5C. GABARIT SPECIAL POPULATION SENIOR
  // ET POPULATION ACTIVE / INACTIVE
  // -------------------------------------------------

  if (isCompact && information.length && visuals.length) {
    content = `
      <div class="pdf-layout-compact">

        <div class="pdf-compact-info">
          ${infoHTML}
        </div>

        <div class="pdf-compact-visuals">
          ${visuals.map(renderVisual).join('')}
        </div>

      </div>
    `;

    console.log(
      `Gabarit compact active : ${title}`
    );

  // Gabarit A : deux visualisations
  } else if (
    information.length &&
    visuals.length === 2 &&
    !complexVisual
  ) {
    content = `
      <div class="pdf-layout-a">
        <div class="pdf-layout-a-info">
          ${infoHTML}
        </div>
        <div class="pdf-layout-a-visuals">
          ${visuals.map(renderVisual).join('')}
        </div>
      </div>
    `;

  // Gabarit B : une visualisation
  } else if (
    information.length &&
    visuals.length === 1 &&
    !complexVisual
  ) {
    content = `
      <div class="pdf-layout-b">
        <div class="pdf-layout-b-info">
          ${infoHTML}
        </div>
        <div class="pdf-layout-b-visual">
          ${renderVisual(visuals[0])}
        </div>
      </div>
    `;

  // Gabarit C : pleine largeur
  } else {
    const visualParts = [];

    for (let i = 0; i < visuals.length; i++) {
      const current = visuals[i];
      const next = visuals[i + 1];

      const canPair =
        next &&
        current.ratio >= 1.7 &&
        next.ratio >= 1.7 &&
        current.height < 550 &&
        next.height < 550;

      if (canPair) {
        visualParts.push(`
          <div class="pdf-visual-pair">
            ${renderVisual(current)}
            ${renderVisual(next)}
          </div>
        `);

        i++;
      } else {
        visualParts.push(`
          <div class="pdf-visual-full">
            ${renderVisual(current)}
          </div>
        `);
      }
    }

    content = `
      <div class="pdf-info-full">
        ${infoHTML}
      </div>
      <div class="pdf-visuals-full">
        ${visualParts.join('')}
      </div>
    `;
  }

  // -------------------------------------------------
  // 5D. STYLES DU DOCUMENT
  // -------------------------------------------------

  const html = `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8">

    <style>
      @page {
        size: A4 landscape;
        margin: 9mm;
      }

      * {
        box-sizing: border-box;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      html, body {
        margin: 0;
        padding: 0;
      }

      body {
        font-family: Raleway, Arial, sans-serif;
        color: #041447;
        background: white;
        font-size: 9.5pt;
        line-height: 1.35;
      }

      .pdf-heading {
        border-bottom: 2px solid #F24E4C;
        margin-bottom: 4mm;
        padding-bottom: 3mm;
        break-after: avoid;
      }

      .pdf-brand {
        font-size: 8pt;
        font-weight: 700;
        color: #041447;
        letter-spacing: .5px;
        margin-bottom: 2mm;
      }

      h1 {
        font-size: 18pt;
        color: #041447;
        line-height: 1.15;
        margin: 0 0 2mm;
      }

      .pdf-source {
        font-size: 8pt;
        font-style: italic;
        color: #64748b;
      }

      /* INDICATEURS */

      .pdf-cards {
        display: grid;
        grid-template-columns:
          repeat(2, minmax(0, 1fr));
        gap: 2.5mm;
        margin-bottom: 3mm;
        align-items: start;
      }

      .pdf-card {
        min-width: 0;
        padding: 2.5mm 3mm;
        background: #F6F8FB;
        border: 1px solid #E0E5ED;
        border-radius: 2mm;
        break-inside: avoid;
      }

      .pdf-card-long {
        grid-column: 1 / -1;
      }

      .pdf-card .card__title {
        color: #64748b;
        font-size: 9pt;
        margin: 0 0 1mm;
      }

      .pdf-card .kpi-title {
        color: ${themeColor};
        font-size: 19pt;
        font-weight: 700;
        margin: 1mm 0;
      }

      .pdf-card .description {
        color: #64748b;
        font-size: 8.5pt;
      }

      .pdf-card .card_textpano {
        color: #475569;
        font-size: 9pt;
        line-height: 1.35;
        margin: 0;
        padding: 0;
      }

      .pdf-card p {
        margin: 1mm 0;
      }

      .pdf-text {
        margin: 0 0 3mm;
        font-size: 9pt;
        line-height: 1.35;
      }

      /* VISUALISATIONS */

      .pdf-visual {
        margin: 0;
        padding: 0;
        min-width: 0;
        break-inside: avoid;
      }

      .pdf-visual img {
        display: block;
        width: 100%;
        height: auto;
        max-height: 160mm;
        object-fit: contain;
        object-position: top center;
      }

      /* GABARIT A */

      .pdf-layout-a {
        display: grid;
        grid-template-columns:
          45% minmax(0, 1fr);
        gap: 4mm;
        align-items: start;
      }

      .pdf-layout-a-info {
        min-width: 0;
      }

      .pdf-layout-a-visuals {
        display: grid;
        grid-template-columns: 1fr;
        gap: 3mm;
        min-width: 0;
      }

      .pdf-layout-a-visuals img {
        max-height: 75mm;
      }

      /* GABARIT B */

      .pdf-layout-b {
        display: grid;
        grid-template-columns:
          42% minmax(0, 1fr);
        gap: 4mm;
        align-items: start;
      }

      .pdf-layout-b-info,
      .pdf-layout-b-visual {
        min-width: 0;
      }

      .pdf-layout-b-visual img {
        max-height: 155mm;
      }

      /* GABARIT C */

      .pdf-info-full {
        width: 100%;
        margin-bottom: 3mm;
      }

      .pdf-info-full .pdf-cards {
        grid-template-columns:
          repeat(3, minmax(0, 1fr));
      }

      .pdf-info-full .pdf-card-long {
        grid-column: span 3;
      }

      .pdf-visual-full {
        width: 100%;
        margin-bottom: 4mm;
        break-inside: avoid;
      }

      .pdf-visual-pair {
        display: grid;
        grid-template-columns:
          repeat(2, minmax(0, 1fr));
        gap: 4mm;
        margin-bottom: 4mm;
        break-inside: avoid;
      }

      .pdf-visual-pair img {
        max-height: 135mm;
      }

      /* VERSION 5E : GABARIT COMPACT */

      .pdf-layout-compact {
        display: grid;
        grid-template-columns:
          48% minmax(0, 1fr);
        gap: 4mm;
        align-items: start;
      }

      .pdf-compact-info {
        min-width: 0;
      }

      .pdf-compact-info .pdf-cards {
        grid-template-columns:
          repeat(2, minmax(0, 1fr));
        gap: 2mm;
        margin-bottom: 2mm;
      }

      .pdf-compact-info .pdf-card {
        padding: 2mm;
      }

      .pdf-compact-info .pdf-card-long {
        grid-column: 1 / -1;
      }

      .pdf-compact-info .pdf-card .kpi-title {
        font-size: 17pt;
      }

      .pdf-compact-info .pdf-card .card_textpano {
        font-size: 8.5pt;
        line-height: 1.3;
      }

      .pdf-compact-info .pdf-card p {
        margin: 0.5mm 0;
      }

      .pdf-compact-visuals {
        min-width: 0;
        display: grid;
        grid-template-columns: 1fr;
        gap: 3mm;
      }

      .pdf-compact-visuals img {
        max-height: 78mm;
      }

      /* PAGINATION */

      .pdf-card,
      .pdf-visual,
      .pdf-visual-full {
        break-inside: avoid;
        page-break-inside: avoid;
      }

      img {
        max-width: 100%;
      }
    </style>
  </head>

  <body>
    <div class="pdf-heading">
      <div class="pdf-brand">
        AGGLOMÉRATION MELUN VAL DE SEINE
      </div>

      <h1>${escapeHTML(title)}</h1>

      <div class="pdf-source">
        ${escapeHTML(source)}
      </div>
    </div>

    ${content}
  </body>
  </html>
  `;

  // -------------------------------------------------
  // 5E. IMPRESSION ET CONTROLE
  // -------------------------------------------------

  const pdfContext = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1
  });

  const pdfPage = await pdfContext.newPage();

  try {
    await pdfPage.setContent(html, {
      waitUntil: 'load'
    });

    await pdfPage.evaluate(async () => {
      await document.fonts.ready;

      await Promise.all(
        [...document.images].map(img =>
          img.decode().catch(() => {})
        )
      );
    });

    await pdfPage.pdf({
      path: file,
      format: 'A4',
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true
    });

    // Controle du nombre de pages.

    const pdfBytes = await fs.readFile(file);
    const pdfDocument = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDocument.getPageCount();

    console.log(
      `PDF ${path.basename(file)} : ${pageCount} page(s)`
    );

    if (pageCount > 1) {
      console.warn(
        `Pagination a verifier : ${title} (${pageCount} pages)`
      );
    }

  } finally {
    await pdfContext.close();
  }

  console.log(`PDF finalise : ${file}`);
}

// =====================================================
// 6. GENERATION DES RUBRIQUES
// =====================================================

try {
  const discovery = await preparePage();

  const groups = await discovery.locator(
    '.sidebar-nav .cl-dropdown'
  ).evaluateAll(nodes =>
    nodes.map((node, index) => ({
      index,

      title: node.querySelector(
        '.cl-dropdown-button'
      )?.textContent?.trim() || `Theme ${index + 1}`,

      items: [
        ...node.querySelectorAll('.cl-dropdown-item')
      ].map((item, itemIndex) => ({
        itemIndex,
        title: item.textContent.trim()
      }))
    }))
  );

  await fs.writeFile(
    path.join(OUT, 'rubriques.json'),
    JSON.stringify(groups, null, 2)
  );

  await discovery.close();

  console.log(
    `Detected ${
      groups.reduce(
        (sum, group) => sum + group.items.length,
        0
      )
    } sections`
  );

  let n = 0;

  for (const group of groups) {
    for (const item of group.items) {
      n++;

      const name =
        `${String(n).padStart(2, '0')}-` +
        `${slug(group.title)}-${slug(item.title)}`;

      let page;

      try {
        console.log(
          `Starting ${n}: ${group.title} / ${item.title}`
        );

        page = await preparePage();

        await selectSection(
          page,
          group.index,
          item.itemIndex
        );

        await waitForVisuals(page);

        await page.screenshot({
          path: path.join(OUT, `${name}-screen.png`),
          fullPage: false
        });

        await printSection(
          page,
          path.join(OUT, `${name}.pdf`)
        );

        report.push({
          number: n,
          theme: group.title,
          section: item.title,
          status: 'ok',
          file: `${name}.pdf`
        });

        console.log(`PDF created: ${name}.pdf`);

      } catch (error) {
        console.error(
          `Failed ${name}: ${error.message}`
        );

        report.push({
          number: n,
          theme: group.title,
          section: item.title,
          status: 'error',
          error: error.message
        });

        if (page) {
          await page.screenshot({
            path: path.join(OUT, `${name}-error.png`),
            fullPage: false
          }).catch(() => {});
        }

      } finally {
        if (page) {
          await page.close().catch(() => {});
        }
      }
    }
  }

} finally {
  await fs.writeFile(
    path.join(OUT, 'rapport.json'),
    JSON.stringify(report, null, 2)
  );

  await browser.close();
}

// =====================================================
// 7. BILAN
// =====================================================

const successCount = report.filter(
  item => item.status === 'ok'
).length;

console.log(
  `Finished: ${successCount}/${report.length} PDFs`
);

if (report.some(item => item.status === 'error')) {
  process.exitCode = 1;
}
