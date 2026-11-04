
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// CAMVS - Panorama territorial - assemblage 7.2
// Les bandeaux sont deja crees par generate.mjs.
// Aucune mise a l'echelle des pages thematiques.
const OUT = 'output';
const ASSETS = 'assets';
const URL = 'https://data.melunvaldeseine.fr/pages/test-pano-arnaud/';
const DEST = path.join(OUT, 'Panorama-territorial-Melun-Val-de-Seine.pdf');
const NAVY = '#041447';
const RED = '#F24E4C';

await fs.mkdir(OUT, { recursive: true });

const themes = [
  { name: 'DÉMOGRAPHIE', image: 'population.png' },
  { name: 'EMPLOI', image: 'emploi.png' },
  { name: 'LOGEMENTS', image: 'logement.png' },
  { name: 'ENTREPRISES', image: 'entreprises.png' }
];

const escapeHTML = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const toData = bytes =>
  'data:image/png;base64,' + bytes.toString('base64');

const imageAsset = async filename =>
  toData(await fs.readFile(path.join(ASSETS, filename)));

// =====================================================
// 1. LIRE ET VERIFIER LES PDF INDIVIDUELS
// =====================================================

const report = JSON.parse(
  await fs.readFile(path.join(OUT, 'rapport.json'), 'utf8')
);

if (
  !Array.isArray(report) ||
  !report.length ||
  report.some(x => x.status !== 'ok')
) {
  throw new Error(
    'Assemblage impossible : certaines rubriques ont echoue.'
  );
}

const sections = [];

for (const item of [...report].sort(
  (a, b) => a.number - b.number
)) {
  const source = await PDFDocument.load(
    await fs.readFile(path.join(OUT, item.file))
  );

  sections.push({
    ...item,
    source,
    pages: source.getPageCount()
  });
}

console.log(`${sections.length} rubriques disponibles`);

// =====================================================
// 2. ILLUSTRATIONS COUVERTURE ET SOMMAIRE
// =====================================================

const banner = await imageAsset(
  'homepage-datagrid-banner.png'
);

for (const theme of themes) {
  theme.data = await imageAsset(theme.image);
}

const edition = new Date().toLocaleDateString('fr-FR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Paris'
});

// =====================================================
// 3. CAPTURER LES INDICATEURS CLES HUWISE
// =====================================================

let statsImage;
let featuresImage;
let mapImage;

const browser = await chromium.launch({
  headless: true
});

try {
  const context = await browser.newContext({
    viewport: {
      width: 1600,
      height: 1000
    },
    deviceScaleFactor: 3
  });

  try {
    const page = await context.newPage();

    await page.goto(URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

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

    const overview = page.locator(
      'section.panorama-overview'
    ).first();

    await overview.waitFor({
      state: 'visible',
      timeout: 30000
    });

    const stats = overview.locator(
      '.panorama-overview-stats'
    ).first();

    const features = overview.locator(
      '.panorama-overview-features'
    ).first();

    // Image de la carte sans "Cliquer pour agrandir".
    const map = overview.locator(
      '.panorama-overview-map img'
    ).first();

    for (const item of [stats, features, map]) {
      await item.waitFor({
        state: 'visible',
        timeout: 30000
      });
    }

    await page.waitForFunction(() => {
      const img = document.querySelector(
        '.panorama-overview-map img'
      );

      return img &&
        img.complete &&
        img.naturalWidth > 0;
    }, null, {
      timeout: 30000
    });

    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    await page.waitForTimeout(1500);

    const captures = [
      ['00-indicateurs-chiffres.png', stats],
      ['00-indicateurs-territoire.png', features],
      ['00-indicateurs-carte.png', map]
    ];

    const buffers = [];

    for (const [filename, locator] of captures) {
      const bytes = await locator.screenshot({
        type: 'png',
        animations: 'disabled',
        timeout: 60000
      });

      await fs.writeFile(
        path.join(OUT, filename),
        bytes
      );

      buffers.push(bytes);
    }

    [statsImage, featuresImage, mapImage] =
      buffers.map(toData);

    console.log(
      'Indicateurs et carte captures en haute definition'
    );

  } finally {
    await context.close();
  }

} finally {
  await browser.close();
}

// =====================================================
// 4. SOMMAIRE ET PAGINATION DYNAMIQUE
// =====================================================

let nextPage = 4;

for (const section of sections) {
  section.startPage = nextPage;
  nextPage += section.pages;
}

const tocGroups = themes.map(theme => ({
  ...theme,
  entries: sections.filter(
    section =>
      section.theme.trim().toUpperCase() === theme.name
  )
})).filter(group => group.entries.length);

// =====================================================
// 5. STYLES DES PAGES INTRODUCTIVES
// =====================================================

const css = `
  @page {
    size: A4 landscape;
    margin: 0;
  }

  * {
    box-sizing: border-box;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  html, body {
    margin: 0;
    padding: 0;
    width: 297mm;
    background: white;
    font-family: Raleway, Arial, sans-serif;
  }

  .page {
    position: relative;
    width: 297mm;
    height: 210mm;
    overflow: hidden;
    break-after: page;
    page-break-after: always;
  }

  .page:last-child {
    break-after: auto;
    page-break-after: auto;
  }

  .small-heading {
    font-size: 9pt;
    font-weight: 700;
    letter-spacing: 1px;
    color: #60708A;
  }

  .accent {
    width: 28mm;
    height: 1.2mm;
    background: ${RED};
  }

  .intro-footer {
    position: absolute;
    bottom: 9mm;
    left: 15mm;
    right: 15mm;
    display: flex;
    justify-content: space-between;
    font-size: 8pt;
    color: #64748B;
  }

  .overview-grid {
    display: grid;
    grid-template-columns: 30fr 30fr 40fr;
    gap: 4mm;
    height: 142mm;
    align-items: center;
  }

  .overview-block {
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .overview-block img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
  }

  .overview-map img {
    max-height: 140mm;
  }
`;

// =====================================================
// 6. COUVERTURE
// =====================================================

const coverHTML = `
<div class="page" style="
  background:${NAVY};
  color:white;
">
  <div style="
    position:absolute;
    top:18mm;
    left:20mm;
    font-size:12pt;
    font-weight:700;
    letter-spacing:1px;
  ">
    AGGLOMÉRATION MELUN VAL DE SEINE
  </div>

  <div style="
    position:absolute;
    top:20mm;
    right:20mm;
    font-size:11pt;
    color:#C6D9F3;
  ">
    ${escapeHTML(edition)}
  </div>

  <div style="
    position:absolute;
    left:20mm;
    top:53mm;
  ">
    <div style="
      font-size:43pt;
      font-weight:800;
      line-height:1.12;
      letter-spacing:-1px;
    ">
      Panorama
      <div>territorial</div>
    </div>

    <div style="
      width:28mm;
      height:1.5mm;
      background:${RED};
      margin-top:12mm;
    "></div>

    <div style="
      margin-top:9mm;
      font-size:15pt;
      color:#D8E8FF;
    ">
      20 communes, un territoire en données
    </div>
  </div>

  <img src="${banner}" style="
    position:absolute;
    left:0;
    bottom:0;
    width:100%;
    height:72mm;
    object-fit:cover;
    object-position:center bottom;
  ">

  <div style="
    position:absolute;
    left:20mm;
    bottom:12mm;
    font-size:11pt;
    font-weight:600;
  ">
    data.melunvaldeseine.fr
  </div>
</div>
`;

// =====================================================
// 7. SOMMAIRE ILLUSTRE
// =====================================================

const tocHTML = `
<div class="page" style="
  background:white;
  color:${NAVY};
  padding:15mm 18mm;
">
  <div class="small-heading">
    PANORAMA TERRITORIAL
  </div>

  <h1 style="
    font-size:29pt;
    margin:5mm 0 2mm;
    font-weight:800;
  ">
    Sommaire
  </h1>

  <div class="accent" style="
    margin-bottom:9mm;
  "></div>

  <div style="
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:7mm;
  ">
    ${tocGroups.map((group, index) => `
      <div style="
        border:1px solid #E0E5ED;
        border-radius:3mm;
        overflow:hidden;
        background:#F7F9FC;
      ">
        <div style="
          height:19mm;
          background:${NAVY};
          position:relative;
          overflow:hidden;
          padding:5mm;
          color:white;
        ">
          <img src="${group.data}" style="
            position:absolute;
            right:0;
            bottom:0;
            width:60%;
            height:100%;
            object-fit:cover;
            opacity:.8;
          ">

          <div style="
            position:relative;
            z-index:1;
            font-size:14pt;
            font-weight:800;
          ">
            ${String(index + 1).padStart(2, '0')}
            &nbsp; ${escapeHTML(group.name)}
          </div>
        </div>

        <div style="padding:4mm 5mm;">
          ${group.entries.map(section => `
            <div style="
              display:flex;
              justify-content:space-between;
              gap:5mm;
              padding:1.5mm 0;
              font-size:9pt;
              line-height:1.25;
              border-bottom:1px solid #E6EAF0;
            ">
              <span>
                ${escapeHTML(section.section)}
              </span>

              <strong style="
                color:${RED};
                white-space:nowrap;
              ">
                ${section.startPage}
              </strong>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('')}
  </div>

  <div class="intro-footer">
    <span>data.melunvaldeseine.fr</span>
    <span>Sommaire</span>
  </div>
</div>
`;

// =====================================================
// 8. PAGE DES INDICATEURS CLES
// =====================================================

const overviewHTML = `
<div class="page" style="
  background:white;
  color:${NAVY};
  padding:13mm 15mm;
">
  <div style="
    display:flex;
    justify-content:space-between;
    align-items:center;
  ">
    <div class="small-heading">
      PANORAMA TERRITORIAL
    </div>

    <div style="
      color:${RED};
      font-size:9pt;
      font-weight:700;
    ">
      LE TERRITOIRE
    </div>
  </div>

  <h1 style="
    font-size:25pt;
    font-weight:800;
    margin:6mm 0 3mm;
  ">
    Les indicateurs clés du territoire
  </h1>

  <div class="accent" style="
    margin-bottom:6mm;
  "></div>

  <div class="overview-grid">
    <div class="overview-block">
      <img src="${statsImage}"
        alt="Chiffres clés du territoire">
    </div>

    <div class="overview-block">
      <img src="${featuresImage}"
        alt="Caractéristiques du territoire">
    </div>

    <div class="overview-block overview-map">
      <img src="${mapImage}"
        alt="Carte de Melun Val de Seine">
    </div>
  </div>

  <div class="intro-footer">
    <span>
      Source : data.melunvaldeseine.fr
    </span>
    <span>
      Agglomération Melun Val de Seine
    </span>
  </div>
</div>
`;

// =====================================================
// 9. GENERER LES 3 PAGES D'INTRODUCTION
// =====================================================

const introBrowser = await chromium.launch({
  headless: true
});

try {
  const context = await introBrowser.newContext({
    viewport: {
      width: 1600,
      height: 1100
    }
  });

  try {
    const page = await context.newPage();

    await page.setContent(`
      <!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <style>${css}</style>
        </head>
        <body>
          ${coverHTML}
          ${tocHTML}
          ${overviewHTML}
        </body>
      </html>
    `, {
      waitUntil: 'load'
    });

    await page.evaluate(async () => {
      await document.fonts.ready;

      await Promise.all(
        [...document.images].map(img => img.decode())
      );
    });

    await page.pdf({
      path: path.join(OUT, '00-introduction.pdf'),
      format: 'A4',
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true
    });

  } finally {
    await context.close();
  }

} finally {
  await introBrowser.close();
}

// =====================================================
// 10. ASSEMBLAGE SANS REDUCTION DES PAGES
// =====================================================

const finalPDF = await PDFDocument.create();

const introPDF = await PDFDocument.load(
  await fs.readFile(
    path.join(OUT, '00-introduction.pdf')
  )
);

if (introPDF.getPageCount() !== 3) {
  throw new Error(
    `Introduction : 3 pages attendues, ` +
    `${introPDF.getPageCount()} obtenues.`
  );
}

const introPages = await finalPDF.copyPages(
  introPDF,
  introPDF.getPageIndices()
);

for (const page of introPages) {
  finalPDF.addPage(page);
}

// Copier chaque page telle quelle.
// Aucun bandeau supplementaire.
// Aucune reduction a 92 %.

for (const section of sections) {
  const copied = await finalPDF.copyPages(
    section.source,
    section.source.getPageIndices()
  );

  for (const page of copied) {
    finalPDF.addPage(page);
  }

  console.log(
    `Ajout sans reduction : ` +
    `${section.theme} / ${section.section} ` +
    `(${section.pages} page(s))`
  );
}

// =====================================================
// 11. PAGINATION CONTINUE
// =====================================================

const font = await finalPDF.embedFont(
  StandardFonts.Helvetica
);

const pages = finalPDF.getPages();
const total = pages.length;

for (let index = 2; index < total; index++) {
  const page = pages[index];
  const { width } = page.getSize();

  page.drawText(`${index + 1} / ${total}`, {
    x: width - 75,
    y: 12,
    size: 8,
    font,
    color: rgb(0.38, 0.44, 0.52)
  });
}

// =====================================================
// 12. METADONNEES ET ENREGISTREMENT
// =====================================================

finalPDF.setTitle(
  'Panorama territorial - Melun Val de Seine'
);

finalPDF.setAuthor(
  'Agglomeration Melun Val de Seine'
);

finalPDF.setSubject(
  'Indicateurs territoriaux et donnees publiques'
);

await fs.writeFile(
  DEST,
  await finalPDF.save()
);

console.log(`PDF complet cree : ${DEST}`);
console.log(
  `${sections.length} rubriques - ${total} pages`
);
