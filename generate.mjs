
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';
import path from 'node:path';

// =====================================================
// PANORAMA TERRITORIAL - CAMVS
// VERSION 7.2 - ILLUSTRATIONS ET GRAPHIQUES HD
// =====================================================

const URL =
  'https://data.melunvaldeseine.fr/pages/test-pano-arnaud/';

const OUT = 'output';
const ASSETS = 'assets';
const TIMEOUT = 60000;

const NAVY = '#041447';
const RED = '#F24E4C';

const THEMES = [
  {
    key: 'demographie',
    name: 'DÉMOGRAPHIE',
    image: 'population.png',
    color: '#E79995'
  },
  {
    key: 'emploi',
    name: 'EMPLOI',
    image: 'emploi.png',
    color: '#0D47B3'
  },
  {
    key: 'logements',
    name: 'LOGEMENTS',
    image: 'logement.png',
    color: '#3A8BA9'
  },
  {
    key: 'entreprises',
    name: 'ENTREPRISES',
    image: 'entreprises.png',
    color: '#8A6EA9'
  }
];

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true
});

const report = [];
const illustrations = new Map();

for (const theme of THEMES) {
  const buffer = await fs.readFile(
    path.join(ASSETS, theme.image)
  );

  illustrations.set(
    theme.key,
    'data:image/png;base64,' +
    buffer.toString('base64')
  );
}

// =====================================================
// UTILITAIRES
// =====================================================

function slug(value) {
  return String(value)
    .normalize('NFD')
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

function getTheme(name) {
  const normalized = slug(name);

  return THEMES.find(theme =>
    normalized.includes(theme.key)
  ) || THEMES.find(theme =>
    normalized === slug(theme.name)
  );
}

// =====================================================
// 1. OUVERTURE HUWISE
// =====================================================

async function preparePage() {
  const page = await browser.newPage({
    viewport: {
      width: 1600,
      height: 1000
    },
    deviceScaleFactor: 3
  });

  page.setDefaultTimeout(TIMEOUT);

  await page.goto(URL, {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  });

  await page.locator(
    '.sidebar-nav .cl-dropdown'
  ).first().waitFor({
    state: 'attached'
  });

  await page.addStyleTag({
    content: `
      ods-manage-cookies-preferences-modal,
      .ods-manage-cookies-preferences,
      .modal-backdrop {
        display:none !important;
        pointer-events:none !important;
      }
    `
  });

  return page;
}

// =====================================================
// 2. NAVIGATION ANGULARJS
// =====================================================

async function selectSection(
  page,
  groupIndex,
  itemIndex
) {
  const group = page.locator(
    '.sidebar-nav .cl-dropdown'
  ).nth(groupIndex);

  const button = group.locator(
    '.cl-dropdown-button'
  );

  const item = group.locator(
    '.cl-dropdown-item'
  ).nth(itemIndex);

  const ngClick = await item.getAttribute(
    'ng-click'
  );

  const match = ngClick?.match(
    /activeSubmenu\s*=\s*['"]([^'"]+)['"]/
  );

  if (!match) {
    throw new Error(
      'Identifiant de rubrique introuvable'
    );
  }

  const submenuId = match[1];

  console.log(`Selection : ${submenuId}`);

  const sectionVisible = () =>
    page.evaluate(expected =>
      [...document.querySelectorAll(
        '.content-area .content-section'
      )].some(section =>
        (section.getAttribute('ng-if') || '')
          .includes(expected) &&
        section.getBoundingClientRect().height > 0
      ),
      submenuId
    );

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await sectionVisible()) {
      console.log(
        `Section affichee : ${submenuId}`
      );
      return;
    }

    console.log(
      `Tentative ${attempt}/3 : ${submenuId}`
    );

    const isOpen = await button.evaluate(el =>
      el.classList.contains(
        'cl-dropdown-button-open'
      )
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
      )?.classList.contains(
        'cl-dropdown-visible'
      );
    }, groupIndex, {
      timeout: 10000
    });

    await item.click({
      timeout: 15000
    });

    try {
      await page.waitForFunction(expected =>
        [...document.querySelectorAll(
          '.content-area .content-section'
        )].some(section =>
          (section.getAttribute('ng-if') || '')
            .includes(expected) &&
          section.getBoundingClientRect().height > 0
        ),
        submenuId,
        { timeout: 8000 }
      );

      console.log(
        `Section affichee : ${submenuId}`
      );

      return;

    } catch {
      console.warn(
        `Selection non confirmee : ${attempt}`
      );

      await page.waitForTimeout(1000);
    }
  }

  throw new Error(
    `Impossible d'afficher ${submenuId}`
  );
}

// =====================================================
// 3. CHARGEMENT DES VISUALISATIONS
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
        if (img.complete) {
          return Promise.resolve();
        }

        return new Promise(resolve => {
          const finish = () => resolve();

          img.addEventListener(
            'load', finish, { once: true }
          );

          img.addEventListener(
            'error', finish, { once: true }
          );

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
      chart.querySelector(
        '.highcharts-container'
      )
    );
  }, null, {
    timeout: 15000
  }).catch(() => {
    console.warn(
      'Certains graphiques ne sont pas confirmes'
    );
  });

  await page.waitForTimeout(3500);

  console.log('Visualisations preparees');
}

// =====================================================
// 4. GENERATION D'UNE SOUS-THEMATIQUE
// =====================================================

async function printSection(
  page,
  file,
  theme,
  firstOfTheme
) {
  const section = page.locator(
    '.content-area .content-section:visible'
  ).first();

  await section.waitFor({
    state: 'visible'
  });

  const title = await section.locator(
    '.section-title'
  ).first().innerText();

  const source = await section.locator(
    '.kpi-description'
  ).first().innerText().catch(() => '');

  const themeColor = theme?.color || '#015CA2';

  const isSenior =
    /population s[eé]nior/i.test(title);

  const isActive =
    /population active et inactive/i.test(title);

  const isCompact = isSenior || isActive;

  const specialEnterprise =
    /formes juridiques|familles d.activit/i
      .test(title);

  // -------------------------------------------------
  // EXTRACTION DES BLOCS
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
  // CONSTRUCTION DES CONTENUS
  // -------------------------------------------------

  const renderCards = element => `
    <div class="pdf-cards">
      ${element.cards.map(card => `
        <div class="pdf-card ${
          card.textLength > 240
            ? 'pdf-card-long'
            : ''
        }">
          ${card.html}
        </div>
      `).join('')}
    </div>
  `;

  const renderInfo = element =>
    element.type === 'cards'
      ? renderCards(element)
      : `<div class="pdf-text">${element.html}</div>`;

  const renderVisual = element => `
    <figure class="pdf-visual">
      <img
        src="data:image/png;base64,${element.image}"
        alt="Visualisation territoriale"
      >
    </figure>
  `;

  const information = elements.filter(el =>
    el.type === 'cards' || el.type === 'text'
  );

  const visuals = elements.filter(el =>
    el.type === 'visual'
  );

  const infoHTML = information
    .map(renderInfo)
    .join('');

  // Les visualisations sont conservees
  // dans leur ordre d'origine.
  //
  // Un visuel detaille utilise toute la largeur.
  // Les deux colonnes sont reservees aux
  // contenus plus simples.

  const complexVisual = visuals.some(el =>
    el.ratio < 1.15 ||
    el.height > 750
  );

  let content = '';

  if (
    information.length &&
    visuals.length === 1 &&
    !complexVisual
  ) {
    content = `
      <div class="pdf-layout-side">
        <div class="pdf-side-info">
          ${infoHTML}
        </div>
        <div class="pdf-side-visual">
          ${renderVisual(visuals[0])}
        </div>
      </div>
    `;

  } else if (
    information.length &&
    visuals.length === 2 &&
    !complexVisual &&
    !isCompact
  ) {
    // Informations et premier visuel en haut.
    // Deuxieme visuel sur toute la largeur.
    content = `
      <div class="pdf-layout-top">
        <div class="pdf-top-info">
          ${infoHTML}
        </div>
        <div class="pdf-top-visual">
          ${renderVisual(visuals[0])}
        </div>
      </div>

      <div class="pdf-visual-wide">
        ${renderVisual(visuals[1])}
      </div>
    `;

  } else if (
    isCompact &&
    information.length &&
    visuals.length
  ) {
    // Conserver la compacite des rubriques
    // Population senior et Active / inactive.
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

  } else {
    // Graphiques complexes : pleine largeur.
    content = `
      <div class="pdf-info-full">
        ${infoHTML}
      </div>

      <div class="pdf-visuals-full">
        ${visuals.map(element => `
          <div class="pdf-visual-wide">
            ${renderVisual(element)}
          </div>
        `).join('')}
      </div>
    `;
  }

  // -------------------------------------------------
  // EN-TETE THEMATIQUE
  // -------------------------------------------------

  const illustration = theme
    ? illustrations.get(theme.key)
    : null;

  const themeHeader =
    firstOfTheme && theme && illustration
      ? `
        <div class="pdf-theme-banner">
          <div class="pdf-theme-label">
            <div class="pdf-theme-small">
              PANORAMA TERRITORIAL
            </div>
            <div class="pdf-theme-name">
              ${escapeHTML(theme.name)}
            </div>
          </div>

          <img
            src="${illustration}"
            alt=""
            class="pdf-theme-image"
          >
        </div>
      `
      : `
        <div class="pdf-small-header">
          <span>PANORAMA TERRITORIAL</span>
          <span>${escapeHTML(
            theme?.name || ''
          )}</span>
        </div>
      `;

  // -------------------------------------------------
  // HTML ET CSS
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
        color: ${NAVY};
        background: white;
        font-size: 9.5pt;
        line-height: 1.35;
      }

      /* EN-TETE THEMATIQUE */

      .pdf-theme-banner {
        position: relative;
        height: 28mm;
        background: ${NAVY};
        color: white;
        overflow: hidden;
        margin-bottom: 5mm;
        break-after: avoid;
      }

      .pdf-theme-label {
        position: absolute;
        top: 5mm;
        left: 7mm;
        z-index: 2;
      }

      .pdf-theme-small {
        font-size: 7.5pt;
        color: #B8D4F3;
        letter-spacing: 1px;
        margin-bottom: 3mm;
      }

      .pdf-theme-name {
        font-size: 20pt;
        font-weight: 800;
        line-height: 1.1;
      }

      .pdf-theme-image {
        position: absolute;
        right: 0;
        top: 0;
        width: 43%;
        height: 100%;
        object-fit: cover;
        object-position: center;
      }

      .pdf-small-header {
        display: flex;
        justify-content: space-between;
        color: ${NAVY};
        font-size: 8pt;
        font-weight: 700;
        letter-spacing: .5px;
        margin-bottom: 4mm;
      }

      .pdf-heading {
        border-bottom: 2px solid ${RED};
        margin-bottom: 4mm;
        padding-bottom: 2mm;
        break-after: avoid;
      }

      h1 {
        color: ${NAVY};
        font-size: 18pt;
        margin: 0 0 2mm;
        line-height: 1.15;
      }

      .pdf-source {
        color: #64748B;
        font-size: 8pt;
        font-style: italic;
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
        color: #64748B;
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
        color: #64748B;
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
        margin-bottom: 3mm;
        font-size: 9pt;
        line-height: 1.35;
      }

      /* VISUALISATIONS HD */

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
        max-height: 165mm;
        object-fit: contain;
        object-position: top center;
      }

      /* GABARIT : INDICATEURS + VISUEL */

      .pdf-layout-side {
        display: grid;
        grid-template-columns:
          38% minmax(0, 1fr);
        gap: 5mm;
        align-items: start;
      }

      .pdf-side-info,
      .pdf-side-visual {
        min-width: 0;
      }

      .pdf-side-visual img {
        max-height: 155mm;
      }

      /* GABARIT : PARTIE HAUTE */

      .pdf-layout-top {
        display: grid;
        grid-template-columns:
          40% minmax(0, 1fr);
        gap: 5mm;
        align-items: start;
        margin-bottom: 4mm;
      }

      .pdf-top-info,
      .pdf-top-visual {
        min-width: 0;
      }

      .pdf-top-visual img {
        max-height: 100mm;
      }

      /* GRAPHIQUE PLEINE LARGEUR */

      .pdf-visual-wide {
        width: 100%;
        margin: 3mm 0 5mm;
        break-inside: avoid;
      }

      .pdf-visual-wide img {
        width: 100%;
        max-height: 155mm;
      }

      /* GABARIT COMPACT */

      .pdf-layout-compact {
        display: grid;
        grid-template-columns:
          46% minmax(0, 1fr);
        gap: 4mm;
        align-items: start;
      }

      .pdf-compact-info,
      .pdf-compact-visuals {
        min-width: 0;
      }

      .pdf-compact-info .pdf-cards {
        gap: 2mm;
        margin-bottom: 2mm;
      }

      .pdf-compact-info .pdf-card {
        padding: 2mm;
      }

      .pdf-compact-info .kpi-title {
        font-size: 17pt;
      }

      .pdf-compact-info .card_textpano {
        font-size: 8.5pt;
      }

      .pdf-compact-visuals {
        display: grid;
        grid-template-columns: 1fr;
        gap: 3mm;
      }

      .pdf-compact-visuals img {
        max-height: 83mm;
      }

      /* GABARIT PLEINE LARGEUR */

      .pdf-info-full {
        width: 100%;
        margin-bottom: 3mm;
      }

      .pdf-info-full .pdf-cards {
        grid-template-columns:
          repeat(3, minmax(0, 1fr));
      }

      .pdf-info-full .pdf-card-long {
        grid-column: 1 / -1;
      }

      /* PAGINATION */

      .pdf-card,
      .pdf-visual,
      .pdf-theme-banner {
        page-break-inside: avoid;
        break-inside: avoid;
      }

      img {
        max-width: 100%;
      }

    </style>
  </head>

  <body>
    ${themeHeader}

    <div class="pdf-heading">
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
  // IMPRESSION PDF
  // -------------------------------------------------

  const pdfContext = await browser.newContext({
    viewport: {
      width: 1600,
      height: 1000
    },
    deviceScaleFactor: 1
  });

  try {
    const pdfPage = await pdfContext.newPage();

    await pdfPage.setContent(html, {
      waitUntil: 'load'
    });

    await pdfPage.evaluate(async () => {
      await document.fonts.ready;

      await Promise.all(
        [...document.images].map(img =>
          img.decode()
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

    const bytes = await fs.readFile(file);
    const pdf = await PDFDocument.load(bytes);

    console.log(
      `${title} : ${pdf.getPageCount()} page(s)`
    );

    if (pdf.getPageCount() > 1) {
      console.warn(
        `Pagination a verifier : ${title}`
      );
    }

  } finally {
    await pdfContext.close();
  }

  console.log(`PDF finalise : ${file}`);
}

// =====================================================
// 5. DECOUVERTE ET GENERATION
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
      )?.textContent?.trim() ||
        `Theme ${index + 1}`,

      items: [
        ...node.querySelectorAll(
          '.cl-dropdown-item'
        )
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
        (sum, group) =>
          sum + group.items.length,
        0
      )
    } sections`
  );

  let n = 0;

  for (const group of groups) {
    const theme = getTheme(group.title);

    for (const item of group.items) {
      n++;

      const name =
        `${String(n).padStart(2, '0')}-` +
        `${slug(group.title)}-` +
        `${slug(item.title)}`;

      const file = path.join(
        OUT,
        `${name}.pdf`
      );

      const firstOfTheme =
        item.itemIndex === 0;

      let page;

      try {
        console.log(
          `Starting ${n}: ` +
          `${group.title} / ${item.title}`
        );

        page = await preparePage();

        await selectSection(
          page,
          group.index,
          item.itemIndex
        );

        await waitForVisuals(page);

        await page.screenshot({
          path: path.join(
            OUT,
            `${name}-screen.png`
          ),
          fullPage: false
        });

        await printSection(
          page,
          file,
          theme,
          firstOfTheme
        );

        report.push({
          number: n,
          theme: group.title,
          section: item.title,
          status: 'ok',
          file: `${name}.pdf`
        });

        console.log(
          `PDF created: ${name}.pdf`
        );

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
            path: path.join(
              OUT,
              `${name}-error.png`
            ),
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
// 6. BILAN
// =====================================================

const successCount = report.filter(
  item => item.status === 'ok'
).length;

console.log(
  `Finished: ${successCount}/${report.length} PDFs`
);

if (report.some(
  item => item.status === 'error'
)) {
  process.exitCode = 1;
}
