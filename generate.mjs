
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';
import path from 'node:path';

// =====================================================
// PANORAMA TERRITORIAL - MELUN VAL DE SEINE
// VERSION 7.3 - PAGINATION ET VISUALISATIONS HD
// =====================================================

const URL =
  'https://data.melunvaldeseine.fr/pages/test-pano-arnaud/';

const OUT = 'output';
const ASSETS = 'assets';
const TIMEOUT = 60000;

const NAVY = '#041447';
const RED = '#F24E4C';

await fs.mkdir(OUT, { recursive: true });

// =====================================================
// CONFIGURATION DES THEMATIQUES
// =====================================================


/* =====================================================
   EXPORT PDF MENSUEL - PERIMETRE AUTORISE

   ATTENTION :
   Seules les 4 thematiques historiques sont exportees.

   Les nouvelles thematiques (Menages, Mobilite,
   Sante, Patrimoine) sont volontairement exclues.

   Pour les inclure plus tard :
   1. Modifier cette liste
   2. Adapter assemble.mjs
   3. Adapter le controle dans panorama.yml
   4. Tester le PDF avant publication
   ===================================================== */

const THEMES_AUTORISES_PDF = new Set([
  'demographie',
  'emploi',
  'logements',
  'entreprises'
]);


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

// =====================================================
// CONFIGURATION DES GABARITS
// =====================================================

// Le gabarit est choisi selon l'identifiant
// AngularJS de chaque sous-thematique.
//
// compact : indicateurs a gauche, visuels a droite
// standard : indicateurs et visuels en colonnes
// full : indicateurs puis visuels pleine largeur
// detail : premier visuel avec les indicateurs,
//          second visuel sur une page dediee

const LAYOUTS = {
  'population': 'detail',
  'territoire-jeune': 'compact',
  'population-senior': 'compact',

  'population-active': 'compact',
  'emploi-offre': 'compact',
  'emploi-taux': 'standard',
  'emploi-conditions': 'compact',

  'categories-logements': 'compact',
  'logements-individuels': 'standard',
  'statut-occupation': 'compact',
  'periodes-construction': 'standard',

  'repartition-commune': 'compact',
  'filtre-entreprises': 'full'
};

const browser = await chromium.launch({
  headless: true
});

const report = [];
const illustrations = new Map();

// =====================================================
// 1. UTILITAIRES
// =====================================================

function slug(value) {
  return String(value ?? '')
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
    normalized === theme.key
  ) || null;
}

function getLayout(submenuId) {
  return LAYOUTS[submenuId] || 'compact';
}

// Charger les quatre illustrations.
for (const theme of THEMES) {
  const bytes = await fs.readFile(
    path.join(ASSETS, theme.image)
  );

  illustrations.set(
    theme.key,
    'data:image/png;base64,' +
      bytes.toString('base64')
  );
}

// =====================================================
// 2. OUVERTURE DE LA PAGE HUWISE
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

  // Neutralisation de la fenetre de cookies.
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
// 3. NAVIGATION ANGULARJS
// =====================================================

async function selectSection(
  page,
  groupIndex,
  itemIndex
) {
  const group = page
    .locator('.sidebar-nav .cl-dropdown')
    .nth(groupIndex);

  const button = group.locator(
    '.cl-dropdown-button'
  );

  const item = group
    .locator('.cl-dropdown-item')
    .nth(itemIndex);

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
      console.log(
        `Section affichee : ${submenuId}`
      );

      return submenuId;
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
      }, submenuId, {
        timeout: 8000
      });

      console.log(
        `Section affichee : ${submenuId}`
      );

      return submenuId;

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

  // Parcourir les graphiques et les cartes.
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

  // Attendre le chargement des images.
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

  // Attendre les graphiques Highcharts.
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
// 5. EXTRACTION DES BLOCS
// =====================================================

async function extractElements(page, section, title) {
  const blocks = section.locator(
    '.cards-grid, .chart-section, .map-section'
  );

  const elements = [];
  const count = await blocks.count();

  const specialEnterprise =
    /formes juridiques|familles d.activit/i
      .test(title);

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

  return elements;
}

// =====================================================
// 6. GENERATION DU HTML
// =====================================================

function renderCards(element) {
  return `
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
}

function renderInformation(element) {
  if (element.type === 'cards') {
    return renderCards(element);
  }

  return `
    <div class="pdf-text">
      ${element.html}
    </div>
  `;
}

function renderVisual(element) {
  return `
    <figure class="pdf-visual">
      <img
        src="data:image/png;base64,${element.image}"
        alt="Visualisation territoriale"
      >
    </figure>
  `;
}

// =====================================================
// 7. COMPOSITION DES GABARITS
// =====================================================

function composeContent(elements, layout) {
  const information = elements.filter(el =>
    el.type === 'cards' || el.type === 'text'
  );

  const visuals = elements.filter(el =>
    el.type === 'visual'
  );

  const infoHTML = information
    .map(renderInformation)
    .join('');

  // -----------------------------------------------
  // GABARIT COMPACT
  // -----------------------------------------------

  if (layout === 'compact') {
    return `
      <div class="pdf-layout-compact">

        <div class="pdf-compact-info">
          ${infoHTML}
        </div>

        <div class="pdf-compact-visuals">
          ${visuals.map(renderVisual).join('')}
        </div>

      </div>
    `;
  }

  // -----------------------------------------------
  // GABARIT STANDARD
  // -----------------------------------------------

  if (layout === 'standard') {
    return `
      <div class="pdf-layout-standard">

        <div class="pdf-standard-info">
          ${infoHTML}
        </div>

        <div class="pdf-standard-visuals">
          ${visuals.map(renderVisual).join('')}
        </div>

      </div>
    `;
  }

  // -----------------------------------------------
  // GABARIT DETAIL
  // -----------------------------------------------

  if (layout === 'detail') {
    if (visuals.length >= 2) {
      return `
        <div class="pdf-layout-detail">

          <div class="pdf-detail-top">
            <div class="pdf-detail-info">
              ${infoHTML}
            </div>

            <div class="pdf-detail-map">
              ${renderVisual(visuals[0])}
            </div>
          </div>

          <div class="pdf-detail-chart">
            ${renderVisual(visuals[1])}
          </div>

          ${visuals.slice(2).map(renderVisual).join('')}

        </div>
      `;
    }

    // Repli pour les rubriques sans deux visuels.
    return `
      <div class="pdf-layout-standard">
        <div class="pdf-standard-info">
          ${infoHTML}
        </div>
        <div class="pdf-standard-visuals">
          ${visuals.map(renderVisual).join('')}
        </div>
      </div>
    `;
  }

  // -----------------------------------------------
  // GABARIT PLEINE LARGEUR
  // -----------------------------------------------

  return `
    <div class="pdf-layout-full">

      <div class="pdf-full-info">
        ${infoHTML}
      </div>

      <div class="pdf-full-visuals">
        ${visuals.map(renderVisual).join('')}
      </div>

    </div>
  `;
}

// =====================================================
// 8. EN-TETE THEMATIQUE
// =====================================================

function renderHeader(
  theme,
  firstOfTheme,
  title,
  source
) {
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
            class="pdf-theme-image"
            alt=""
          >

        </div>
      `
      : `
        <div class="pdf-small-header">
          <span>PANORAMA TERRITORIAL</span>
          <span>
            ${escapeHTML(theme?.name || '')}
          </span>
        </div>
      `;

  return `
    ${themeHeader}

    <div class="pdf-heading">
      <h1>${escapeHTML(title)}</h1>

      <div class="pdf-source">
        ${escapeHTML(source)}
      </div>
    </div>
  `;
}

// =====================================================
// 9. STYLES DES PDF
// =====================================================

function getCSS(themeColor) {
  return `
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

    /* =========================================
       EN-TETES
       ========================================= */

    .pdf-theme-banner {
      position: relative;
      height: 25mm;
      background: ${NAVY};
      color: white;
      overflow: hidden;
      margin-bottom: 4mm;
      break-after: avoid;
    }

    .pdf-theme-label {
      position: absolute;
      top: 5mm;
      left: 7mm;
      z-index: 2;
    }

    .pdf-theme-small {
      font-size: 7pt;
      color: #B8D4F3;
      letter-spacing: 1px;
      margin-bottom: 2mm;
    }

    .pdf-theme-name {
      font-size: 19pt;
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
    }

    .pdf-small-header {
      display: flex;
      justify-content: space-between;
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: .5px;
      margin-bottom: 3mm;
    }

    .pdf-heading {
      border-bottom: 2px solid ${RED};
      padding-bottom: 2mm;
      margin-bottom: 3mm;
      break-after: avoid;
    }

    h1 {
      font-size: 17pt;
      color: ${NAVY};
      line-height: 1.15;
      margin: 0 0 1.5mm;
    }

    .pdf-source {
      color: #64748B;
      font-size: 8pt;
      font-style: italic;
    }

    /* =========================================
       CARTES D'INDICATEURS
       ========================================= */

    .pdf-cards {
      display: grid;
      grid-template-columns:
        repeat(2, minmax(0, 1fr));
      gap: 2mm;
      margin-bottom: 2mm;
      align-items: start;
    }

    .pdf-card {
      min-width: 0;
      padding: 2mm 2.5mm;
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
      font-size: 8.5pt;
      margin: 0 0 1mm;
    }

    .pdf-card .kpi-title {
      color: ${themeColor};
      font-size: 18pt;
      font-weight: 700;
      margin: 1mm 0;
    }

    .pdf-card .description {
      color: #64748B;
      font-size: 8pt;
    }

    .pdf-card .card_textpano {
      color: #475569;
      font-size: 8.5pt;
      line-height: 1.3;
      margin: 0;
      padding: 0;
    }

    .pdf-card p {
      margin: .5mm 0;
    }

    .pdf-text {
      margin-bottom: 2mm;
      font-size: 9pt;
      line-height: 1.35;
    }

    /* =========================================
       VISUALISATIONS
       ========================================= */

    .pdf-visual {
      margin: 0;
      padding: 0;
      min-width: 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .pdf-visual img {
      display: block;
      width: 100%;
      height: auto;
      max-height: 155mm;
      object-fit: contain;
      object-position: top center;
    }

    /* =========================================
       GABARIT COMPACT
       ========================================= */

    .pdf-layout-compact {
      display: grid;
      grid-template-columns:
        48% minmax(0, 1fr);
      gap: 4mm;
      align-items: start;
    }

    .pdf-compact-info,
    .pdf-compact-visuals {
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
      max-height: 75mm;
    }

    /* =========================================
       GABARIT STANDARD
       ========================================= */

    .pdf-layout-standard {
      display: grid;
      grid-template-columns:
        42% minmax(0, 1fr);
      gap: 5mm;
      align-items: start;
    }

    .pdf-standard-info,
    .pdf-standard-visuals {
      min-width: 0;
    }

    .pdf-standard-visuals {
      display: grid;
      grid-template-columns: 1fr;
      gap: 4mm;
    }

    .pdf-standard-visuals img {
      max-height: 145mm;
    }

    /* =========================================
       GABARIT DETAIL
       ========================================= */

    .pdf-layout-detail {
      width: 100%;
    }

    .pdf-detail-top {
      display: grid;
      grid-template-columns:
        42% minmax(0, 1fr);
      gap: 5mm;
      align-items: start;
    }

    .pdf-detail-info,
    .pdf-detail-map {
      min-width: 0;
    }

    .pdf-detail-map img {
      max-height: 105mm;
    }

    .pdf-detail-chart {
      width: 100%;
      margin-top: 6mm;
      break-before: page;
      page-break-before: always;
    }

    .pdf-detail-chart img {
      max-height: 155mm;
    }

    /* =========================================
       GABARIT PLEINE LARGEUR
       ========================================= */

    .pdf-layout-full {
      width: 100%;
    }

    .pdf-full-info {
      width: 100%;
      margin-bottom: 4mm;
    }

    .pdf-full-info .pdf-cards {
      grid-template-columns:
        repeat(3, minmax(0, 1fr));
    }

    .pdf-full-info .pdf-card-long {
      grid-column: 1 / -1;
    }

    .pdf-full-visuals {
      display: grid;
      grid-template-columns: 1fr;
      gap: 5mm;
    }

    .pdf-full-visuals img {
      max-height: 155mm;
    }

    /* =========================================
       IMPRESSION
       ========================================= */

    .pdf-card,
    .pdf-visual,
    .pdf-theme-banner {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    img {
      max-width: 100%;
    }
  `;
}

// =====================================================
// 10. GENERATION DU PDF
// =====================================================

async function printSection(
  page,
  file,
  theme,
  firstOfTheme,
  submenuId
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

  const elements = await extractElements(
    page,
    section,
    title
  );

  console.log(
    `${title} : ${elements.length} blocs prepares`
  );

  const layout = getLayout(submenuId);

  console.log(
    `Gabarit : ${layout}`
  );

  const content = composeContent(
    elements,
    layout
  );

  const header = renderHeader(
    theme,
    firstOfTheme,
    title,
    source
  );

  const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <style>
        ${getCSS(themeColor)}
      </style>
    </head>

    <body>
      ${header}
      ${content}
    </body>
    </html>
  `;

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

    const pageCount = pdf.getPageCount();

    console.log(
      `${title} : ${pageCount} page(s)`
    );

    if (pageCount > 1) {
      console.warn(
        `Pagination a verifier : ${title}`
      );
    }

    return pageCount;

  } finally {
    await pdfContext.close();
  }
}

// =====================================================
// 11. DECOUVERTE DES RUBRIQUES
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

  const totalSections = groups.reduce(
    (sum, group) =>
      sum + group.items.length,
    0
  );

  console.log(
    `Detected ${totalSections} sections`
  );

  // =================================================
  // 12. GENERATION DES 13 PDF
  // =================================================

  let n = 0;

  for (const group of groups) {
    const theme = getTheme(group.title);

    
    // =================================================
    // BLOCAGE DES NOUVELLES THEMATIQUES POUR LE PDF
    //
    // Seules Demographie, Emploi, Logements et
    // Entreprises sont autorisees.
    //
    // Les nouvelles thematiques sont ignorees.
    // NE PAS SUPPRIMER avant validation.
    // =================================================

    if (
      !theme ||
      !THEMES_AUTORISES_PDF.has(theme.key)
    ) {
      console.log(
        `PDF EXCLU : ${group.title}`
      );
      continue;
    }


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

        const submenuId = await selectSection(
          page,
          group.index,
          item.itemIndex
        );

        await waitForVisuals(page);

        // Capture de diagnostic.
        await page.screenshot({
          path: path.join(
            OUT,
            `${name}-screen.png`
          ),
          fullPage: false
        });

        const pageCount = await printSection(
          page,
          file,
          theme,
          firstOfTheme,
          submenuId
        );

        report.push({
          number: n,
          theme: group.title,
          section: item.title,
          status: 'ok',
          file: `${name}.pdf`,
          pages: pageCount,
          layout: getLayout(submenuId)
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
// 13. BILAN
// =====================================================

const successCount = report.filter(
  item => item.status === 'ok'
).length;

const totalPages = report
  .filter(item => item.status === 'ok')
  .reduce(
    (sum, item) => sum + (item.pages || 0),
    0
  );

console.log(
  `Finished: ${successCount}/${report.length} PDFs`
);

console.log(
  `Total pages thematiques : ${totalPages}`
);

console.log(
  `Panorama estime : ${totalPages + 3} pages`
);

if (report.some(item =>
  item.status === 'error'
)) {
  process.exitCode = 1;
}


// =====================================================
// CONTROLE FINAL : 13 RUBRIQUES HISTORIQUES
//
// Ce controle empeche de valider une generation
// incomplete ou contenant des rubriques inattendues.
// =====================================================

if (report.length !== 13) {
  console.error(
    `ERREUR : ${report.length} rubriques generees, ` +
    '13 attendues.'
  );

  process.exitCode = 1;
}

