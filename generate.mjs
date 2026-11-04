
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// =====================================================
// PANORAMA TERRITORIAL CAMVS
// GENERATE.MJS - VERSION 5C
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
// 1. OUVERTURE DE LA PAGE HUWISE
// =====================================================

async function preparePage() {

  const page = await browser.newPage({
    viewport: {
      width: 1600,
      height: 1000
    },
    deviceScaleFactor: 1
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

  // Neutraliser la fenetre de cookies
  // uniquement dans le navigateur du robot.

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
// 3. SELECTION DES SOUS-THEMATIQUES
// Navigation AngularJS avec trois tentatives
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

    return await page.evaluate(expected => {

      return [
        ...document.querySelectorAll(
          '.content-area .content-section'
        )
      ].some(section => {

        const condition =
          section.getAttribute('ng-if') || '';

        return (
          condition.includes(expected) &&
          section.getBoundingClientRect().height > 0
        );
      });

    }, submenuId);
  };

  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {

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

      const group =
        document.querySelectorAll(
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
        ].some(section => {

          const condition =
            section.getAttribute('ng-if') || '';

          return (
            condition.includes(expected) &&
            section.getBoundingClientRect().height > 0
          );
        });

      }, submenuId, {
        timeout: 8000
      });

      console.log(
        `Section affichee : ${submenuId}`
      );

      return;

    } catch (error) {

      console.warn(
        `Selection non confirmee, tentative ${attempt}`
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

  // Parcourir les visualisations pour declencher
  // leur chargement progressif.

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

  // Attendre les images.

  await page.evaluate(async () => {

    await Promise.all(
      [...document.images].map(img => {

        if (img.complete) {
          return Promise.resolve();
        }

        return new Promise(resolve => {

          const finish = () => resolve();

          img.addEventListener(
            'load',
            finish,
            { once: true }
          );

          img.addEventListener(
            'error',
            finish,
            { once: true }
          );

          setTimeout(finish, 8000);
        });
      })
    );
  });

  // Verifier les graphiques Highcharts.

  await page.waitForFunction(() => {

    const charts =
      document.querySelectorAll(
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
// 5. GENERATION PDF - VERSION 5C
// =====================================================

async function printSection(page, file) {

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

  // -------------------------------------------------
  // 5A. RECUPERER LES BLOCS
  // -------------------------------------------------

  const blocks = section.locator(
    '.cards-grid, .chart-section, .map-section'
  );

  const elements = [];
  const count = await blocks.count();

  for (let i = 0; i < count; i++) {

    const block = blocks.nth(i);

    // Ignorer les blocs imbriques.

    const nested = await block.evaluate(el => {

      return !!el.parentElement.closest(
        '.cards-grid, .chart-section, .map-section'
      );
    });

    if (nested) continue;

    const box = await block.boundingBox();

    if (!box || box.height < 5) {
      continue;
    }

    const isCards = await block.evaluate(el =>
      el.classList.contains('cards-grid')
    );

    // Exception pour les indicateurs dynamiques
    // de la rubrique Entreprises.

    const captureAsImage =
      /formes juridiques|familles d.activit/i
        .test(title);

    if (isCards && !captureAsImage) {

      const cards = await block.locator(
        ':scope > .card'
      ).evaluateAll(nodes =>
        nodes.map(card => ({
          html: card.innerHTML
        }))
      );

      if (cards.length > 0) {

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

      // Capture des cartes et graphiques,
      // et des indicateurs Entreprises speciaux.

      await block.scrollIntoViewIfNeeded();

      await page.waitForTimeout(
        captureAsImage ? 700 : 400
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
        ratio: box.width / box.height
      });
    }
  }

  console.log(
    `${title} : ${elements.length} blocs prepares`
  );

  // -------------------------------------------------
  // 5B. CONSTRUIRE LES BLOCS HTML
  // -------------------------------------------------

  const renderVisual = element => `
    <div class="pdf-visual">
      <img
        src="data:image/png;base64,${element.image}"
        alt="Visualisation territoriale"
      >
    </div>
  `;

  const renderElement = element => {

    if (element.type === 'cards') {

      return `
        <div class="pdf-cards">
          ${element.cards.map(card => `
            <div class="pdf-card">
              ${card.html}
            </div>
          `).join('')}
        </div>
      `;
    }

    if (element.type === 'text') {

      return `
        <div class="pdf-text">
          ${element.html}
        </div>
      `;
    }

    return renderVisual(element);
  };

  // -------------------------------------------------
  // 5C. CHOISIR LE GABARIT
  // -------------------------------------------------

  const information = elements.filter(
    element =>
      element.type === 'cards' ||
      element.type === 'text'
  );

  const visuals = elements.filter(
    element => element.type === 'visual'
  );

  const ratio = element =>
    element.ratio ||
    (
      element.width && element.height
        ? element.width / element.height
        : 1
    );

  const contentParts = [];

  // Gabarit A :
  // Indicateurs a gauche, deux visualisations
  // a droite.

  if (
    information.length > 0 &&
    visuals.length === 2
  ) {

    contentParts.push(`
      <div class="pdf-layout-a">

        <div class="pdf-layout-a-info">
          ${information.map(renderElement).join('')}
        </div>

        <div class="pdf-layout-a-visuals">
          ${visuals.map(renderVisual).join('')}
        </div>

      </div>
    `);

  // Gabarit B :
  // Indicateurs a gauche, un graphique a droite.

  } else if (
    information.length > 0 &&
    visuals.length === 1
  ) {

    contentParts.push(`
      <div class="pdf-layout-b">

        <div class="pdf-layout-b-info">
          ${information.map(renderElement).join('')}
        </div>

        <div class="pdf-layout-b-chart">
          ${renderVisual(visuals[0])}
        </div>

      </div>
    `);

  // Gabarit C :
  // Visualisations complexes, pleine largeur
  // ou par paires.

  } else {

    contentParts.push(
      information.map(renderElement).join('')
    );

    for (
      let i = 0;
      i < visuals.length;
      i++
    ) {

      const current = visuals[i];
      const next = visuals[i + 1];

      if (
        next &&
        ratio(current) >= 1.4 &&
        ratio(next) >= 1.4
      ) {

        contentParts.push(`
          <div class="pdf-layout-pair">
            ${renderVisual(current)}
            ${renderVisual(next)}
          </div>
        `);

        i++;

      } else {

        contentParts.push(`
          <div class="pdf-layout-full">
            ${renderVisual(current)}
          </div>
        `);
      }
    }
  }

  const content = contentParts.join('');

  // -------------------------------------------------
  // 5D. DOCUMENT HTML INDEPENDANT
  // -------------------------------------------------

  const html = `
  <!DOCTYPE html>
  <html lang="fr">

  <head>
    <meta charset="UTF-8">

    <style>

      @page {
        size: A4 landscape;
        margin: 10mm;
      }

      * {
        box-sizing: border-box;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      html,
      body {
        margin: 0;
        padding: 0;
      }

      body {
        font-family: Raleway, Arial, sans-serif;
        font-size: 10pt;
        line-height: 1.4;
        color: #041447;
        background: #ffffff;
      }

      /* EN-TETE */

      .pdf-heading {
        border-bottom: 2px solid #F24E4C;
        padding-bottom: 3mm;
        margin-bottom: 5mm;
        break-after: avoid;
      }

      .pdf-brand {
        color: #041447;
        font-size: 8pt;
        font-weight: 700;
        letter-spacing: 0.7px;
        margin-bottom: 3mm;
      }

      h1 {
        color: #041447;
        font-size: 19pt;
        line-height: 1.2;
        margin: 0 0 2mm;
      }

      .pdf-source {
        color: #64748b;
        font-size: 8.5pt;
        font-style: italic;
      }

      /* INDICATEURS */

      .pdf-cards {
        display: grid;
        grid-template-columns:
          repeat(2, minmax(0, 1fr));
        gap: 3mm;
        margin-bottom: 4mm;
        align-items: start;
      }

      .pdf-card {
        background: #F6F8FB;
        border: 1px solid #E0E5ED;
        border-radius: 2mm;
        padding: 3mm;
        min-width: 0;
        margin-bottom: 2mm;
        break-inside: avoid;
      }

      .pdf-card .card__title {
        color: #64748b;
        font-size: 9pt;
        margin: 0 0 2mm;
      }

      .pdf-card .kpi-title {
        color: ${themeColor};
        font-size: 20pt;
        font-weight: 700;
        margin: 2mm 0;
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

      .pdf-text {
        margin-bottom: 4mm;
        line-height: 1.4;
      }

      /* VISUALISATIONS */

      .pdf-visual {
        width: 100%;
        min-width: 0;
        margin: 0 0 4mm;
        break-inside: avoid;
      }

      .pdf-visual img {
        display: block;
        width: 100%;
        height: auto;
        max-height: 155mm;
        object-fit: contain;
        object-position: top center;
      }

      /* GABARIT A */

      .pdf-layout-a {
        display: grid;
        grid-template-columns:
          40% minmax(0, 1fr);
        gap: 5mm;
        align-items: start;
      }

      .pdf-layout-a-info {
        min-width: 0;
      }

      .pdf-layout-a-info .pdf-cards {
        grid-template-columns: 1fr;
      }

      .pdf-layout-a-visuals {
        display: grid;
        grid-template-columns: 1fr;
        gap: 4mm;
        min-width: 0;
      }

      /* GABARIT B */

      .pdf-layout-b {
        display: grid;
        grid-template-columns:
          35% minmax(0, 1fr);
        gap: 6mm;
        align-items: start;
      }

      .pdf-layout-b-info,
      .pdf-layout-b-chart {
        min-width: 0;
      }

      .pdf-layout-b-info .pdf-cards {
        grid-template-columns: 1fr;
      }

      /* GABARIT C */

      .pdf-layout-pair {
        display: grid;
        grid-template-columns:
          repeat(2, minmax(0, 1fr));
        gap: 5mm;
        align-items: start;
      }

      .pdf-layout-full {
        width: 100%;
        margin-bottom: 4mm;
      }

      /* PAGINATION */

      .pdf-heading,
      .pdf-card,
      .pdf-visual {
        page-break-inside: avoid;
        break-inside: avoid;
      }

      .pdf-layout-pair {
        break-inside: avoid;
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
  // 5E. GENERATION DU PDF
  // -------------------------------------------------

  const pdfContext = await browser.newContext({
    viewport: {
      width: 1600,
      height: 1000
    },
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

  } finally {

    await pdfContext.close();
  }

  console.log(`PDF finalise : ${file}`);
}

// =====================================================
// 6. DECOUVERTE ET GENERATION DES 13 RUBRIQUES
// =====================================================

try {

  const discovery = await preparePage();

  const groups = await discovery.locator(
    '.sidebar-nav .cl-dropdown'
  ).evaluateAll(nodes =>
    nodes.map((node, index) => ({

      index,

      title:
        node.querySelector(
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

  let n = 0;

  for (const group of groups) {

    for (const item of group.items) {

      n++;

      const name =
        `${String(n).padStart(2, '0')}-` +
        `${slug(group.title)}-` +
        `${slug(item.title)}`;

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

        // Capture de diagnostic.

        await page.screenshot({
          path: path.join(
            OUT,
            `${name}-screen.png`
          ),
          fullPage: false
        });

        // Generation du PDF.

        await printSection(
          page,
          path.join(
            OUT,
            `${name}.pdf`
          )
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

  // Conserver le rapport meme en cas d'erreur.

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

if (report.some(
  item => item.status === 'error'
)) {
  process.exitCode = 1;
}
