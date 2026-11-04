
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  PDFDocument,
  StandardFonts,
  rgb
} from 'pdf-lib';

// =====================================================
// PANORAMA TERRITORIAL - MELUN VAL DE SEINE
// ASSEMBLAGE VERSION 6 CORRIGEE
// =====================================================

const OUT = 'output';
const ASSETS = 'assets';

const URL =
  'https://data.melunvaldeseine.fr/pages/test-pano-arnaud/';

const DEST = path.join(
  OUT,
  'Panorama-territorial-Melun-Val-de-Seine.pdf'
);

await fs.mkdir(OUT, { recursive: true });

const themes = [
  {
    name: 'DÉMOGRAPHIE',
    image: 'population.png',
    subtitle: 'Population, âge et séniors'
  },
  {
    name: 'EMPLOI',
    image: 'emploi.png',
    subtitle: 'Activité et conditions de travail'
  },
  {
    name: 'LOGEMENTS',
    image: 'logement.png',
    subtitle: 'Habitat et parc de logements'
  },
  {
    name: 'ENTREPRISES',
    image: 'entreprises.png',
    subtitle: 'Établissements et tissu économique'
  }
];

// =====================================================
// 1. UTILITAIRES
// =====================================================

const escapeHTML = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

async function imageData(filename) {
  const bytes = await fs.readFile(
    path.join(ASSETS, filename)
  );

  return 'data:image/png;base64,' +
    bytes.toString('base64');
}

function bufferToData(buffer) {
  return 'data:image/png;base64,' +
    buffer.toString('base64');
}

// =====================================================
// 2. CHARGER LES PDF INDIVIDUELS
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
    'Assemblage impossible : certaines rubriques ont echoue.'
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
// 3. CHARGER LES ILLUSTRATIONS
// =====================================================

const banner = await imageData(
  'homepage-datagrid-banner.png'
);

for (const theme of themes) {
  theme.data = await imageData(theme.image);
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
// 4. CAPTURER LES INDICATEURS CLES HUWISE
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

  // Masquer la fenetre de cookies.
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

  const map = overview.locator(
    '.panorama-overview-map'
  ).first();

  await stats.waitFor({
    state: 'visible',
    timeout: 30000
  });

  await features.waitFor({
    state: 'visible',
    timeout: 30000
  });

  await map.waitFor({
    state: 'visible',
    timeout: 30000
  });

  // Verifier que la carte est chargee.
  const mapPicture = map.locator('img').first();

  await mapPicture.waitFor({
    state: 'visible',
    timeout: 30000
  });

  await mapPicture.evaluate(async img => {
    if (!img.complete) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(
            new Error('Chargement carte trop long')
          ),
          20000
        );

        const finish = () => {
          clearTimeout(timeout);
          resolve();
        };

        img.addEventListener('load', finish, {
          once: true
        });

        img.addEventListener('error', finish, {
          once: true
        });
      });
    }

    if (img.naturalWidth === 0) {
      throw new Error(
        'Image de la carte non chargee'
      );
    }
  });

  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  // Capturer chaque bloc independamment.
  // Le scrollIntoViewIfNeeded est gere par
  // Playwright lors de chaque screenshot.

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

  statsImage = bufferToData(statsBuffer);
  featuresImage = bufferToData(featuresBuffer);
  mapImage = bufferToData(mapBuffer);

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
    'Indicateurs cles : trois blocs captures'
  );

  await context.close();

} finally {
  await browser.close();
}

// =====================================================
// 5. CALCULER LA PAGINATION
// =====================================================

// Page 1 : couverture
// Page 2 : sommaire
// Page 3 : indicateurs cles
// Page 4 : premiere sous-thematique

let nextPage = 4;

for (const section of sections) {
  section.startPage = nextPage;
  nextPage += section.pages;
}

// =====================================================
// 6. STYLES GENERAUX
// =====================================================

const baseCSS = `
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
  }

  body {
    font-family: Raleway, Arial, sans-serif;
  }

  .page {
    position: relative;
    width: 297mm;
    height: 210mm;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
  }

  .page:last-child {
    page-break-after: auto;
    break-after: auto;
  }
`;

// =====================================================
// 7. COUVERTURE
// =====================================================

const coverHTML = `
<div class="page" style="
  background:#041447;
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
      Panorama<br>
      territorial
    </div>

    <div style="
      width:28mm;
      height:1.5mm;
      background:#F24E4C;
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
    color:white;
    font-weight:600;
  ">
    data.melunvaldeseine.fr
  </div>

</div>
`;

// =====================================================
// 8. SOMMAIRE ILLUSTRE
// =====================================================

const tocGroups = themes.map(theme => {
  const entries = sections.filter(
    section =>
      section.theme.toUpperCase() === theme.name
  );

  return {
    ...theme,
    entries
  };
}).filter(group => group.entries.length);

const tocHTML = `
<div class="page" style="
  background:#FFFFFF;
  color:#041447;
  padding:15mm 18mm;
">

  <div style="
    font-size:10pt;
    font-weight:700;
    letter-spacing:1px;
    color:#60708A;
  ">
    PANORAMA TERRITORIAL
  </div>

  <h1 style="
    font-size:29pt;
    margin:5mm 0 2mm;
    font-weight:800;
  ">
    Sommaire
  </h1>

  <div style="
    height:1.2mm;
    width:28mm;
    background:#F24E4C;
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
          background:#041447;
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
              align-items:flex-start;
              padding:1.5mm 0;
              font-size:9pt;
              line-height:1.25;
              border-bottom:1px solid #E6EAF0;
            ">

              <span>
                ${escapeHTML(section.section)}
              </span>

              <strong style="
                color:#F24E4C;
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

  <div style="
    position:absolute;
    bottom:8mm;
    left:18mm;
    right:18mm;
    display:flex;
    justify-content:space-between;
    color:#64748B;
    font-size:8pt;
  ">
    <span>data.melunvaldeseine.fr</span>
    <span>Sommaire</span>
  </div>

</div>
`;

// =====================================================
// 9. PAGE DES INDICATEURS CLES
// =====================================================

const overviewHTML = `
<div class="page" style="
  background:#FFFFFF;
  color:#041447;
  padding:13mm 15mm;
">

  <div style="
    display:flex;
    justify-content:space-between;
    align-items:center;
  ">

    <div style="
      font-size:9pt;
      font-weight:700;
      letter-spacing:1px;
      color:#60708A;
    ">
      PANORAMA TERRITORIAL
    </div>

    <div style="
      font-size:9pt;
      color:#F24E4C;
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

  <div style="
    width:28mm;
    height:1.2mm;
    background:#F24E4C;
    margin-bottom:7mm;
  "></div>

  <div style="
    display:grid;
    grid-template-columns:
      27% 27% minmax(0, 1fr);
    gap:5mm;
    height:135mm;
    align-items:center;
  ">

    <div style="
      min-width:0;
      display:flex;
      align-items:center;
      justify-content:center;
    ">
      <img src="${statsImage}" style="
        display:block;
        width:100%;
        height:auto;
        max-height:135mm;
        object-fit:contain;
      ">
    </div>

    <div style="
      min-width:0;
      display:flex;
      align-items:center;
      justify-content:center;
    ">
      <img src="${featuresImage}" style="
        display:block;
        width:100%;
        height:auto;
        max-height:135mm;
        object-fit:contain;
      ">
    </div>

    <div style="
      min-width:0;
      display:flex;
      align-items:center;
      justify-content:center;
    ">
      <img src="${mapImage}" style="
        display:block;
        width:100%;
        height:auto;
        max-height:135mm;
        object-fit:contain;
      ">
    </div>

  </div>

  <div style="
    position:absolute;
    bottom:9mm;
    left:15mm;
    right:15mm;
    display:flex;
    justify-content:space-between;
    font-size:8pt;
    color:#64748B;
  ">

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
// 10. GENERER LES TROIS PAGES D'INTRODUCTION
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
        <style>${baseCSS}</style>
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
        img.decode().catch(() => {})
      )
    );
  });

  await page.pdf({
    path: path.join(
      OUT,
      '00-introduction.pdf'
    ),
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
// 11. ASSEMBLAGE FINAL
// =====================================================

const finalPDF = await PDFDocument.create();

const introBytes = await fs.readFile(
  path.join(OUT, '00-introduction.pdf')
);

const introPDF = await PDFDocument.load(introBytes);

if (introPDF.getPageCount() !== 3) {
  throw new Error(
    'Introduction invalide : 3 pages attendues, ' +
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

for (const section of sections) {
  const copied = await finalPDF.copyPages(
    section.source,
    section.source.getPageIndices()
  );

  for (const page of copied) {
    finalPDF.addPage(page);
  }
}

// =====================================================
// 12. PAGINATION
// =====================================================

const font = await finalPDF.embedFont(
  StandardFonts.Helvetica
);

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
// 13. METADONNEES ET ENREGISTREMENT
// =====================================================

finalPDF.setTitle(
  'Panorama territorial - Melun Val de Seine'
);

finalPDF.setAuthor(
  'Agglomération Melun Val de Seine'
);

finalPDF.setSubject(
  'Indicateurs territoriaux et données publiques'
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
