
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const URL = 'https://data.melunvaldeseine.fr/pages/test-pano-arnaud/';
const OUT = 'output';
const TIMEOUT = 60000;

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const report = [];

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

  await page.locator('.sidebar-nav .cl-dropdown')
    .first().waitFor({ state: 'attached' });

  // Masquer la fenetre cookies uniquement dans le robot
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

function slug(value) {
  return value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 55);
}




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

  // Fonction de verification du contenu
  const sectionVisible = async () => {
    return await page.evaluate(expected => {
      return [...document.querySelectorAll(
        '.content-area .content-section'
      )].some(section =>
        (section.getAttribute('ng-if') || '')
          .includes(expected) &&
        section.getBoundingClientRect().height > 0
      );
    }, submenuId);
  };

  // Maximum 3 tentatives
  for (let attempt = 1; attempt <= 3; attempt++) {

    if (await sectionVisible()) {
      console.log(`Section affichee : ${submenuId}`);
      return;
    }

    console.log(
      `Tentative ${attempt}/3 : ${submenuId}`
    );

    // Ouvrir le menu si necessaire
    const isOpen = await button.evaluate(el =>
      el.classList.contains('cl-dropdown-button-open')
    );

    if (!isOpen) {
      await button.click();
    }

    // Attendre que le menu soit ouvert
    await page.waitForFunction(index => {
      const group = document.querySelectorAll(
        '.sidebar-nav .cl-dropdown'
      )[index];

      return group?.querySelector(
        '.cl-dropdown-menu'
      )?.classList.contains('cl-dropdown-visible');
    }, groupIndex, { timeout: 10000 });

    // Cliquer normalement
    await item.click({ timeout: 15000 });

    // Attendre la section, sans bloquer definitivement
    try {
      await page.waitForFunction(expected => {
        return [...document.querySelectorAll(
          '.content-area .content-section'
        )].some(section =>
          (section.getAttribute('ng-if') || '')
            .includes(expected) &&
          section.getBoundingClientRect().height > 0
        );
      }, submenuId, { timeout: 8000 });

      console.log(`Section affichee : ${submenuId}`);
      return;

    } catch (error) {
      console.warn(
        `Selection non confirmee, tentative ${attempt}`
      );

      await page.waitForTimeout(1000);
    }
  }

  throw new Error(
    `Impossible d'afficher la rubrique ${submenuId} apres 3 tentatives`
  );
}





async function waitForVisuals(page) {

  // Attendre que la rubrique active soit visible
  const section = page.locator(
    '.content-area .content-section:visible'
  ).first();

  await section.waitFor({
    state: 'visible',
    timeout: 30000
  });

  // Attendre le chargement des polices
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  // Parcourir progressivement la page pour
  // declencher les chargements des visualisations
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

  // Revenir au debut de la rubrique
  await section.scrollIntoViewIfNeeded();

  // Attendre les images HTML
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

  // Attendre les graphiques Highcharts
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

  // Laisser les cartes terminer leurs chargements
  await page.waitForTimeout(3500);

  console.log('Visualisations preparees');
}






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

  const themeClass = await section.getAttribute('class');

  let themeColor = '#015ca2';

  if (themeClass.includes('theme-demographie'))
    themeColor = '#e79995';

  if (themeClass.includes('theme-emploi'))
    themeColor = '#0d47b3';

  if (themeClass.includes('theme-logement'))
    themeColor = '#3a8ba9';

  if (themeClass.includes('theme-entreprises'))
    themeColor = '#8a6ea9';

  // Echappement du texte pour le HTML
  const escapeHTML = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Recuperer uniquement les blocs de premier niveau
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

    if (isCards) {

      
      // Les indicateurs dynamiques de la rubrique
      // Entreprises ne peuvent pas toujours etre
      // reproduits dans une page HTML independante.

      const captureAsImage =
        title.includes('formes juridiques') ||
        title.includes('familles d’activités');

      if (captureAsImage) {
        await block.scrollIntoViewIfNeeded();
        await page.waitForTimeout(700);

        const image = await block.screenshot({
          type: 'png',
          animations: 'disabled',
          scale: 'css',
          timeout: 30000
        });

        
        elements.push({
          type: 'visual',
          image: image.toString('base64'),
          width: box.width,
          height: box.height,
          ratio: box.width / box.height
        });


        continue;
      }

      // Conserver le texte et les indicateurs en HTML
      const cards = await block.locator(
        ':scope > .card'
      ).evaluateAll(nodes => nodes.map(card => ({
        html: card.innerHTML
      })));

      if (cards.length > 0) {
        elements.push({
          type: 'cards',
          cards
        });
      } else {
        // Cas des blocs de texte sans .card
        const html = await block.innerHTML();

        elements.push({
          type: 'text',
          html
        });
      }

    } else {

      // Capturer uniquement les graphiques et cartes
      await block.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);

      const image = await block.screenshot({
        type: 'png',
        animations: 'disabled',
        scale: 'css',
        timeout: 30000
      });

      elements.push({
        type: 'visual',
        image: image.toString('base64')
      });
    }
  }

  console.log(
    `${title} : ${elements.length} blocs prepares`
  );

  
  // Construire une mise en page editoriale adaptative

  const renderVisual = element => `
    <div class="pdf-visual">
      <img
        src="data:image/png;base64,${element.image}"
        alt="Visualisation du panorama"
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

  const contentParts = [];

  for (let i = 0; i < elements.length; i++) {

    const current = elements[i];
    const next = elements[i + 1];

    // Deux graphiques assez larges peuvent
    // etre places sur une meme ligne.
    // Les graphiques hauts restent pleine largeur.

    if (
      current.type === 'visual' &&
      next?.type === 'visual' &&
      current.ratio >= 1.3 &&
      next.ratio >= 1.3
    ) {

      contentParts.push(`
        <div class="pdf-visual-grid">
          ${renderVisual(current)}
          ${renderVisual(next)}
        </div>
      `);

      i++;
      continue;
    }

    contentParts.push(renderElement(current));
  }

  const content = contentParts.join('');


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
      }

      html, body {
        margin: 0;
        padding: 0;
      }

      body {
        font-family: Arial, sans-serif;
        color: #334155;
        background: #ffffff;
        font-size: 10pt;
        line-height: 1.45;
      }

      .pdf-heading {
        border-bottom: 2px solid ${themeColor};
        padding-bottom: 4mm;
        margin-bottom: 5mm;
        break-after: avoid;
      }

      .pdf-brand {
        color: #015ca2;
        font-size: 8pt;
        font-weight: 700;
        letter-spacing: 0.5px;
        margin-bottom: 3mm;
      }

      h1 {
        color: #142e7b;
        font-size: 19pt;
        margin: 0 0 2mm;
        line-height: 1.2;
      }

      .pdf-source {
        color: #64748b;
        font-size: 9pt;
        font-style: italic;
      }

      .pdf-cards {
        display: grid;
        grid-template-columns:
          repeat(2, minmax(0, 1fr));
        gap: 4mm;
        margin-bottom: 5mm;
      }

      .pdf-card {
        border: 1px solid #e2e8f0;
        border-radius: 3mm;
        padding: 4mm;
        background: #ffffff;
        break-inside: avoid;
        min-width: 0;
      }

      .pdf-card .card__title {
        color: #64748b;
        font-size: 10pt;
        margin: 0 0 2mm;
      }

      .pdf-card .kpi-title {
        color: ${themeColor};
        font-size: 22pt;
        font-weight: 700;
        margin: 2mm 0;
      }

      .pdf-card .description {
        color: #64748b;
        font-size: 9pt;
      }

      .pdf-card .card_textpano {
        color: #475569;
        font-size: 9.5pt;
        line-height: 1.4;
        margin: 0;
        padding: 0;
      }

      .pdf-text {
        margin-bottom: 5mm;
        break-inside: avoid;
      }

      .pdf-visual {
        width: 100%;
        margin: 4mm 0 6mm;
        break-inside: avoid;
        page-break-inside: avoid;
      }

      .pdf-visual img {
        display: block;
        width: 100%;
        height: auto;
        max-height: 165mm;
        object-fit: contain;
        object-position: top center;
      }

      .pdf-card,
      .pdf-visual {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
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

  // Creer un contexte independant pour le PDF
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

  } finally {
    await pdfContext.close();
  }

  console.log(`PDF finalise : ${file}`);
}



try {
  // Decouvrir les thematiques et sous-thematiques
  const discovery = await preparePage();

  const groups = await discovery.locator(
    '.sidebar-nav .cl-dropdown'
  ).evaluateAll(nodes => nodes.map((node, index) => ({
    index,
    title: node.querySelector('.cl-dropdown-button')
      ?.textContent?.trim() || `Theme ${index + 1}`,
    items: [
      ...node.querySelectorAll('.cl-dropdown-item')
    ].map((item, itemIndex) => ({
      itemIndex,
      title: item.textContent.trim()
    }))
  })));

  await fs.writeFile(
    path.join(OUT, 'rubriques.json'),
    JSON.stringify(groups, null, 2)
  );

  await discovery.close();

  console.log(
    `Detected ${
      groups.reduce((sum, g) => sum + g.items.length, 0)
    } sections`
  );

  let n = 0;

  // Une nouvelle page pour chaque sous-thematique
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

        // Capture de diagnostic
        await page.screenshot({
          path: path.join(OUT, `${name}-screen.png`),
          fullPage: false
        });

        // Generation du PDF
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
  // Sauvegarder le rapport, meme en cas d'erreur
  await fs.writeFile(
    path.join(OUT, 'rapport.json'),
    JSON.stringify(report, null, 2)
  );

  await browser.close();
}

console.log(
  `Finished: ${
    report.filter(x => x.status === 'ok').length
  }/${report.length} PDFs`
);

if (report.some(x => x.status === 'error')) {
  process.exitCode = 1;
}
