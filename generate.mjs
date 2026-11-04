
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

  // Ouvrir le menu si necessaire
  const isOpen = await button.evaluate(el =>
    el.classList.contains('cl-dropdown-button-open')
  );

  if (!isOpen) {
    await button.click();
  }

  // Attendre que le menu soit reellement ouvert
  await page.waitForFunction((index) => {
    const group = document.querySelectorAll(
      '.sidebar-nav .cl-dropdown'
    )[index];

    return group?.querySelector(
      '.cl-dropdown-menu'
    )?.classList.contains('cl-dropdown-visible');
  }, groupIndex, { timeout: 10000 });

  const item = group
    .locator('.cl-dropdown-item')
    .nth(itemIndex);

  // Recuperer l'identifiant AngularJS
  const ngClick = await item.getAttribute('ng-click');

  const match = ngClick?.match(
    /activeSubmenu\s*=\s*['"]([^'"]+)['"]/
  );

  if (!match) {
    throw new Error('Identifiant de rubrique introuvable');
  }

  const submenuId = match[1];

  console.log(`Selection : ${submenuId}`);

  // Cliquer normalement, sans force:true
  await item.click({ timeout: 15000 });

  // Attendre le contenu reellement affiche
  await page.waitForFunction((expected) => {
    return [...document.querySelectorAll(
      '.content-area .content-section'
    )].some(section =>
      (section.getAttribute('ng-if') || '')
        .includes(expected) &&
      section.getBoundingClientRect().height > 0
    );
  }, submenuId, { timeout: 15000 });

  console.log(`Section affichee : ${submenuId}`);
}



async function waitForVisuals(page) {
  // Attendre les indicateurs calcules par HUWISE
  await page.waitForFunction(() => {
    const section = [
      ...document.querySelectorAll(
        '.content-area .content-section'
      )
    ].find(el => el.getBoundingClientRect().height > 0);

    if (!section) return false;

    const kpis = [...section.querySelectorAll('.kpi-title')];

    return kpis.every(el => {
      const value = (el.textContent || '').trim();

      return value &&
        value !== '%' &&
        value !== '-' &&
        value !== 'NaN';
    });
  }, null, { timeout: 25000 }).catch(() => {
    console.warn(
      'Chargement des indicateurs non confirme'
    );
  });

  // Laisser les graphiques et cartes terminer
  await page.waitForTimeout(5000);

  await page.evaluate(async () => {
    await Promise.all(
      [...document.images].map(img =>
        img.complete
          ? Promise.resolve()
          : new Promise(resolve => {
              img.addEventListener('load', resolve, {
                once: true
              });
              img.addEventListener('error', resolve, {
                once: true
              });
              setTimeout(resolve, 8000);
            })
      )
    );
  });
}

async function printSection(page, file) {
  // Styles appliques seulement au PDF
  await page.addStyleTag({
    content: `
      @media print {
        @page {
          size: A4 landscape;
          margin: 12mm;
        }

        .ods-front-header,
        .ods-front-footer,
        .ods-front-header__menu,
        header[role="banner"],
        footer,
        .navbar,
        .sidebar-nav,
        .sticky-content,
        .scroll-indicator,
        .panorama-export-pdf,
        .header,
        .home {
          display: none !important;
        }

        .conteneur,
        .indicateurs,
        .main-content-wrapper,
        .content-area {
          display: block !important;
          width: 100% !important;
          max-width: none !important;
          height: auto !important;
          min-height: 0 !important;
          overflow: visible !important;
          margin: 0 !important;
          padding: 0 !important;
          background: white !important;
        }

        .content-section {
          animation: none !important;
        }

        .chart-section,
        .map-section {
          break-inside: avoid;
          box-shadow: none !important;
        }

        ods-chart,
        .odswidget-chart,
        .highcharts-container,
        svg.highcharts-root {
          max-width: 100% !important;
        }

        * {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
      }
    `
  });

  await page.pdf({
    path: file,
    format: 'A4',
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true
  });
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
