
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  PDFDocument,
  StandardFonts,
  rgb
} from 'pdf-lib';

// =====================================================
// PANORAMA TERRITORIAL CAMVS - VERSION 7
// Assemblage et finition graphique
// =====================================================

const OUT = 'output';
const ASSETS = 'assets';

const URL =
  'https://data.melunvaldeseine.fr/pages/test-pano-arnaud/';

const DEST = path.join(
  OUT,
  'Panorama-territorial-Melun-Val-de-Seine.pdf'
);

const NAVY = '#041447';
const RED = '#F24E4C';

await fs.mkdir(OUT, { recursive: true });

const themes = [
  {
    name: 'DÉMOGRAPHIE',
    image: 'population.png',
    subtitle: 'Population, âge et séniors',
    color: '#E79995'
  },
  {
    name: 'EMPLOI',
    image: 'emploi.png',
    subtitle: 'Activité et conditions de travail',
    color: '#0D47B3'
  },
  {
    name: 'LOGEMENTS',
    image: 'logement.png',
    subtitle: 'Habitat et parc de logements',
    color: '#3A8BA9'
  },
  {
    name: 'ENTREPRISES',
    image: 'entreprises.png',
    subtitle: 'Établissements et tissu économique',
    color: '#8A6EA9'
  }
];

const escapeHTML = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const colorRGB = hex => {
  const value = hex.replace('#', '');
  return rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255
  );
};

async function assetBytes(filename) {
  return fs.readFile(path.join(ASSETS, filename));
}

async function assetData(filename) {
  return 'data:image/png;base64,' +
    (await assetBytes(filename)).toString('base64');
}

function imageData(buffer) {
  return 'data:image/png;base64,' +
    buffer.toString('base64');
}

// =====================================================
// 1. CHARGER LES PDF INDIVIDUELS
// =====================================================

const report = JSON.parse(
  await fs.readFile(
    path.join(OUT, 'rapport.json'),
    'utf8'
  )
);

const successful = report
  .filter(item => item.status === 'ok')
  .sort((a, b) => a.number - b.number);

if (
  successful.length === 0 ||
  successful.length !== report.length
) {
  throw new Error(
    'Assemblage impossible : rubriques manquantes.'
  );
}

const sections = [];

for (const item of successful) {
  const bytes = await fs.readFile(
    path.join(OUT, item.file)
  );

  const source = await PDFDocument.load(bytes);

  sections.push({
    ...item,
    source,
    pages: source.getPageCount()
  });
}

console.log(
  `${sections.length} rubriques disponibles`
);

// =====================================================
// 2. ILLUSTRATIONS
// =====================================================

const banner = await assetData(
  'homepage-datagrid-banner.png'
);

for (const theme of themes) {
  theme.data = await assetData(theme.image);
  theme.bytes = await assetBytes(theme.image);
}

const edition = new Date().toLocaleDateString(
  'fr-FR',
  {
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Paris'
  }
);

// =====================================================
// 3. RECUPERATION DES INDICATEURS HUWISE
// =====================================================

const browser = await chromium.launch({
  headless: true
});

let statsImage;
let featuresImage;
let mapImage;

try {
  const context = await browser.newContext({
    viewport: {
      width: 1600,
      height: 1000
    },
    deviceScaleFactor: 2
  });

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
        display:none !important;
        pointer-events:none !important;
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

  // On capture directement l'image de la carte,
  // sans la mention "Cliquer pour agrandir".
  const map = overview.locator(
    '.panorama-overview-map img'
  ).first();

  for (const block of [stats, features, map]) {
    await block.waitFor({
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

  await page.waitForTimeout(1200);

  const statsBuffer = await stats.screenshot({
    type: 'png',
    animations: 'disabled',
    timeout: 60000
  });

  const featuresBuffer = await features.screenshot({
    type: 'png',
    animations: 'disabled',
    timeout: 60000
  });

  const mapBuffer = await map.screenshot({
    type: 'png',
    animations: 'disabled',
    timeout: 60000
  });

  statsImage = imageData(statsBuffer);
  featuresImage = imageData(featuresBuffer);
  mapImage = imageData(mapBuffer);

  await fs.writeFile(
    path.join(OUT, '00-indicateurs-chiffres.png'),
    statsBuffer
  );

  await fs.writeFile(
    path.join(OUT, '00-indicateurs-territoire.png'),
    featuresBuffer
  );

  await fs.writeFile(
    path.join(OUT, '00-indicateurs-carte.png'),
    mapBuffer
  );

  console.log(
    'Indicateurs et carte captures depuis HUWISE'
  );

  await context.close();

} finally {
  await browser.close();
}

// =====================================================
// 4. PAGINATION ET SOMMAIRE
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
// 5. STYLES HTML DES PAGES D'INTRODUCTION
// =====================================================

const css = `
  @page {
    size:A4 landscape;
    margin:0;
  }

  * {
    box-sizing:border-box;
    -webkit-print-color-adjust:exact;
    print-color-adjust:exact;
  }

  html,body {
    margin:0;
    padding:0;
    width:297mm;
    background:white;
    font-family:Raleway,Arial,sans-serif;
  }

  .page {
    width:297mm;
    height:210mm;
    position:relative;
    overflow:hidden;
    break-after:page;
  }

  .page:last-child {
    break-after:auto;
  }

  .small-heading {
    font-size:9pt;
    font-weight:700;
    letter-spacing:1px;
    color:#60708A;
  }

  .accent {
    width:28mm;
    height:1.2mm;
    background:${RED};
  }

  .intro-footer {
    position:absolute;
    bottom:9mm;
    left:15mm;
    right:15mm;
    display:flex;
    justify-content:space-between;
    font-size:8pt;
    color:#64748B;
  }

  .overview-grid {
    display:grid;
    grid-template-columns:
      minmax(0,30fr)
      minmax(0,30fr)
      minmax(0,40fr);
    gap:4mm;
    height:142mm;
    align-items:center;
  }

  .overview-block {
    min-width:0;
    height:100%;
    display:flex;
    align-items:center;
    justify-content:center;
  }

  .overview-block img {
    display:block;
    max-width:100%;
    max-height:100%;
    width:auto;
    height:auto;
    object-fit:contain;
  }

  .overview-map img {
    max-height:140mm;
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
    color:white;
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
            ${String(index + 1).padStart(2,'0')}
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
// 8. INDICATEURS CLES - PAGE 3
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
      [...document.images].map(img =>
        img.decode()
      )
    );
  });

  await page.pdf({
    path: path.join(OUT, '00-introduction.pdf'),
    format: 'A4',
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true
  });

  await context.close();

} finally {
  await introBrowser.close();
}

// =====================================================
// 10. ASSEMBLAGE FINAL ET BANDEAUX THEMATIQUES
// =====================================================

const finalPDF = await PDFDocument.create();

const introBytes = await fs.readFile(
  path.join(OUT, '00-introduction.pdf')
);

const introPDF = await PDFDocument.load(introBytes);

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

const font = await finalPDF.embedFont(
  StandardFonts.Helvetica
);

const boldFont = await finalPDF.embedFont(
  StandardFonts.HelveticaBold
);

const embeddedImages = new Map();

for (const theme of themes) {
  embeddedImages.set(
    theme.name,
    await finalPDF.embedPng(theme.bytes)
  );
}

const seenThemes = new Set();

for (const section of sections) {
  const themeName =
    section.theme.trim().toUpperCase();

  const theme = themes.find(
    t => t.name === themeName
  );

  const firstOfTheme =
    theme && !seenThemes.has(themeName);

  if (firstOfTheme) {
    seenThemes.add(themeName);

    // Premiere page du chapitre :
    // conserver le contenu en le reduisant
    // legerement pour liberer un bandeau superieur.

    const sourcePage = section.source.getPage(0);

    const [embedded] = await finalPDF.embedPages(
      [sourcePage]
    );

    const { width, height } =
      sourcePage.getSize();

    const newPage = finalPDF.addPage([
      width,
      height
    ]);

    const scale = 0.92;

    const scaledWidth = width * scale;
    const scaledHeight = height * scale;

    newPage.drawPage(embedded, {
      x: (width - scaledWidth) / 2,
      y: 9,
      width: scaledWidth,
      height: scaledHeight
    });

    // Bandeau bleu nuit.
    const bandHeight = 40;

    newPage.drawRectangle({
      x: 0,
      y: height - bandHeight,
      width,
      height: bandHeight,
      color: colorRGB(NAVY)
    });

    // Accent rouge corail.
    newPage.drawRectangle({
      x: 0,
      y: height - bandHeight,
      width: 5,
      height: bandHeight,
      color: colorRGB(RED)
    });

    newPage.drawText(theme.name, {
      x: 22,
      y: height - 25,
      size: 15,
      font: boldFont,
      color: rgb(1, 1, 1)
    });

    // Illustration lumineuse.
    const illustration =
      embeddedImages.get(theme.name);

    const imageWidth = 145;
    const imageHeight = 38;

    newPage.drawImage(illustration, {
      x: width - imageWidth,
      y: height - imageHeight - 1,
      width: imageWidth,
      height: imageHeight
    });

    // Les autres pages de cette rubrique
    // sont conservees sans modification.
    if (section.pages > 1) {
      const indices = Array.from(
        { length: section.pages - 1 },
        (_, i) => i + 1
      );

      const remaining = await finalPDF.copyPages(
        section.source,
        indices
      );

      for (const page of remaining) {
        finalPDF.addPage(page);
      }
    }

    console.log(
      `Bandeau ajoute : ${theme.name}`
    );

  } else {
    // Rubriques suivantes : pages originales.
    const copied = await finalPDF.copyPages(
      section.source,
      section.source.getPageIndices()
    );

    for (const page of copied) {
      finalPDF.addPage(page);
    }
  }
}

// =====================================================
// 11. PAGINATION CONTINUE
// =====================================================

const pages = finalPDF.getPages();
const total = pages.length;

for (let index = 2; index < total; index++) {
  const page = pages[index];
  const { width } = page.getSize();

  const label = `${index + 1} / ${total}`;

  page.drawText(label, {
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

console.log(
  `PDF complet cree : ${DEST}`
);

console.log(
  `${sections.length} rubriques - ${total} pages`
);
