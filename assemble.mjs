
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  PDFDocument,
  StandardFonts,
  rgb
} from 'pdf-lib';

// =====================================================
// PANORAMA TERRITORIAL CAMVS - VERSION 7.6.2
// Couverture institutionnelle corrigee
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
  { name: 'DÉMOGRAPHIE', image: 'population.png' },
  { name: 'EMPLOI', image: 'emploi.png' },
  { name: 'LOGEMENTS', image: 'logement.png' },
  { name: 'ENTREPRISES', image: 'entreprises.png' }
];

// =====================================================
// 1. UTILITAIRES
// =====================================================

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toData(bytes) {
  return 'data:image/png;base64,' +
    bytes.toString('base64');
}

async function imageAsset(filename) {
  return toData(
    await fs.readFile(path.join(ASSETS, filename))
  );
}

function pdfColor(hex) {
  const value = hex.replace('#', '');

  return rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255
  );
}

// =====================================================
// 2. CHARGEMENT DES PDF INDIVIDUELS
// =====================================================

const report = JSON.parse(
  await fs.readFile(
    path.join(OUT, 'rapport.json'),
    'utf8'
  )
);

if (
  !Array.isArray(report) ||
  report.length !== 13 ||
  report.some(item => item.status !== 'ok')
) {
  throw new Error(
    'Assemblage impossible : les 13 rubriques ' +
    'doivent etre generees correctement.'
  );
}

const sections = [];

for (const item of [...report].sort(
  (a, b) => a.number - b.number
)) {
  const source = await PDFDocument.load(
    await fs.readFile(
      path.join(OUT, item.file)
    )
  );

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
// 3. ILLUSTRATIONS ET LOGOS
// =====================================================

const banner = await imageAsset(
  'homepage-datagrid-banner.png'
);

// Logos blancs conserves pour la derniere page.
const logoData = await imageAsset('logo-data.png');
const logoCAMVS = await imageAsset('logo-camvs.png');

// Logos couleur de la nouvelle couverture.
const logoDataCouleur = await imageAsset(
  'logo-data-couleur.png'
);

const logoCAMVSCouleur = await imageAsset(
  'logo-camvs-couleur-2.png'
);

const logoUE = await imageAsset('logo-ue.png');

for (const theme of themes) {
  theme.data = await imageAsset(theme.image);
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
// 4. CAPTURE DES INDICATEURS CLES HUWISE
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
        scale: 'device',
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
      'Indicateurs cles captures en HD'
    );

  } finally {
    await context.close();
  }

} finally {
  await browser.close();
}

// =====================================================
// 5. PAGINATION ET SOMMAIRE
// =====================================================

// Page 1 : couverture
// Page 2 : avant-propos
// Page 3 : sommaire
// Page 4 : indicateurs cles
// Page 5 : premiere sous-thematique

let nextPage = 5;

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
// 6. STYLES GENERAUX
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

  /* LOGOS DE LA QUATRIEME DE COUVERTURE */

  .logos {
    display: flex;
    align-items: center;
    gap: 9mm;
  }

  .logo-data {
    width: 48mm;
    height: 17mm;
    object-fit: contain;
  }

  .logo-camvs {
    width: 39mm;
    height: 23mm;
    object-fit: contain;
  }

  .logo-ue-panel {
    width: 33mm;
    height: 31mm;
    padding: 2mm;
    background: white;
    border-radius: 2mm;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .logo-ue {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  /* AVANT-PROPOS */

  .preamble {
    padding: 14mm 20mm;
    color: ${NAVY};
  }

  .preamble h1 {
    font-size: 28pt;
    line-height: 1.12;
    margin: 4mm 0 3mm;
  }

  .preamble-content {
    max-width: 250mm;
    font-size: 11.5pt;
    line-height: 1.45;
    color: #334155;
  }

  .preamble-content p {
    margin: 0 0 3mm;
  }

  .preamble-content h2 {
    font-size: 13pt;
    color: ${NAVY};
    margin: 4mm 0 2mm;
  }

  .preamble-content strong {
    color: ${NAVY};
  }

  /* INDICATEURS CLES */

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

  .overview-stats img,
  .overview-features img {
    transform: scale(1.07);
    transform-origin: center;
  }

  .overview-map img {
    max-height: 140mm;
  }
`;

// =====================================================
// 7. COUVERTURE VERSION 7.6.2
// =====================================================

const coverHTML = `
<div class="page" style="
  position:relative;
  background:${NAVY};
  color:white;
  overflow:hidden;
">

  <!-- DATA-GRID PLEINE PAGE -->

  <img src="${banner}" style="
    position:absolute;
    inset:0;
    width:100%;
    height:100%;
    object-fit:cover;
    object-position:center center;
    z-index:0;
  ">

  <!-- DEGRADE DE LISIBILITE -->

  <div style="
    position:absolute;
    inset:0;
    z-index:1;
    background:linear-gradient(
      180deg,
      rgba(4,20,71,0.88) 0%,
      rgba(4,20,71,0.70) 33%,
      rgba(4,20,71,0.30) 67%,
      rgba(4,20,71,0.05) 100%
    );
  "></div>

  <!-- IDENTITE INSTITUTIONNELLE -->

  <div style="
    position:absolute;
    top:11mm;
    left:18mm;
    z-index:2;
    font-size:11pt;
    font-weight:700;
    letter-spacing:1.1px;
    color:#E0EDFF;
  ">
    AGGLOMÉRATION MELUN VAL DE SEINE
  </div>

  <!-- DATE AUTOMATIQUE -->

  <div style="
    position:absolute;
    top:11mm;
    right:18mm;
    z-index:2;
    font-size:10pt;
    color:#D8E8FF;
  ">
    ${escapeHTML(edition)}
  </div>

  <!-- TITRE PRINCIPAL -->

  <div style="
    position:absolute;
    top:30mm;
    left:18mm;
    right:18mm;
    z-index:2;
  ">

    <div style="
      font-size:62pt;
      font-weight:800;
      line-height:1.02;
      letter-spacing:-1.5px;
      color:#FFFFFF;
      text-shadow:0 3px 15px rgba(0,0,0,0.15);
    ">
      Panorama<br>
      territorial
    </div>

    <div style="
      width:48mm;
      height:1.7mm;
      background:${RED};
      margin-top:8mm;
    "></div>

    <div style="
      margin-top:6mm;
      font-size:17pt;
      font-weight:500;
      color:#E2EEFF;
    ">
      20 communes, un territoire en données
    </div>

  </div>

  <!-- BANDEAU BLANC COURBE ET VIRGULE FINE -->

  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 1122 794"
    preserveAspectRatio="none"
    style="
      position:absolute;
      inset:0;
      width:100%;
      height:100%;
      z-index:3;
      pointer-events:none;
    "
  >

    <!-- COURBE BLANCHE -->

    <path
      d="
        M 0 705
        C 260 748, 565 730, 785 687
        C 935 660, 1040 624, 1122 595
        L 1122 794
        L 0 794
        Z
      "
      fill="#FFFFFF"
    />

    <!-- VIRGULE BLEU NUIT -->

    <path
      d="
        M 810 645
        C 803 689, 786 748, 758 810
        L 768 810
        C 801 748, 814 690, 814 645
        Z
      "
      fill="#041447"
    />

  </svg>

  <!-- LOGOS PARTENAIRES : UE PUIS DATA -->

  <div style="
    position:absolute;
    left:19mm;
    bottom:6mm;
    width:133mm;
    height:24mm;
    z-index:4;
    display:flex;
    align-items:center;
    justify-content:flex-start;
    gap:13mm;
  ">

    <!-- UNION EUROPEENNE -->

    <div style="
      width:49mm;
      height:23mm;
      flex:0 0 49mm;
      display:flex;
      align-items:center;
      justify-content:center;
    ">

      <img src="${logoUE}" style="
        display:block;
        width:100%;
        height:100%;
        object-fit:contain;
        object-position:center center;
      ">

    </div>

    <!-- PLATEFORME DATA -->

    <div style="
      width:49mm;
      height:23mm;
      flex:0 0 49mm;
      display:flex;
      align-items:center;
      justify-content:center;
    ">

      <img src="${logoDataCouleur}" style="
        display:block;
        width:100%;
        height:100%;
        object-fit:contain;
        object-position:center center;
      ">

    </div>

  </div>

  <!-- LOGO CAMVS A DROITE DE LA VIRGULE -->

  <div style="
    position:absolute;
    right:15mm;
    bottom:9mm;
    width:57mm;
    height:25mm;
    z-index:4;
    display:flex;
    align-items:center;
    justify-content:center;
  ">

    <img src="${logoCAMVSCouleur}" style="
      display:block;
      width:100%;
      height:100%;
      object-fit:contain;
      object-position:center center;
    ">

  </div>

</div>
`;

// =====================================================
// 8. AVANT-PROPOS
// =====================================================

const preambleHTML = `
<div class="page preamble">

  <div class="small-heading">
    PANORAMA TERRITORIAL
  </div>

  <h1>
    Un territoire à découvrir,<br>
    des données à partager
  </h1>

  <div class="accent" style="
    margin-bottom:6mm;
  "></div>

  <div class="preamble-content">

    <p>
      Comment évolue la population de notre territoire ?
      Où se concentrent les emplois ? Quelles sont les
      caractéristiques de nos logements et de notre
      tissu économique ?
    </p>

    <p>
      Avec ce Panorama territorial, l'Agglomération
      Melun Val de Seine propose à chacun — habitants,
      élus, associations, entreprises, étudiants ou
      simples curieux — de mieux connaître les
      20 communes qui composent notre territoire.
    </p>

    <h2>
      Un panorama vivant, alimenté par les données publiques
    </h2>

    <p>
      Ce document est généré automatiquement à partir
      du Panorama territorial disponible sur la plateforme
      <strong>data.melunvaldeseine.fr</strong>.
      Les indicateurs, cartes et graphiques sont issus
      de jeux de données publiques, actualisés au fil
      de leur disponibilité et des mises à jour de leurs
      producteurs. Les sources et les millésimes sont
      précisés au sein des différentes visualisations.
    </p>

    <p>
      Contrairement à une publication statistique
      traditionnelle, ce panorama n'est donc pas figé :
      de nouvelles éditions peuvent être produites
      à partir des données disponibles sur la plateforme.
    </p>

    <h2>La donnée avant la mise en page !</h2>

    <p>
      Parce que ce PDF est produit automatiquement,
      quelques imperfections de présentation peuvent
      subsister : décalages, espacements inhabituels
      ou graphiques répartis sur plusieurs pages.
    </p>

    <p>
      Nous avons fait le choix de privilégier
      <strong>la fiabilité des données, leur actualisation
      et leur accessibilité</strong> plutôt qu'une mise en
      page parfaite. Pour explorer les visualisations,
      appliquer des filtres ou consulter les données
      sources, rendez-vous sur la version interactive
      du Panorama territorial.
    </p>

    <p>
      Vos remarques, suggestions et signalements
      sont les bienvenus :
      <strong>data@camvs.com</strong>.
    </p>

  </div>

  <img src="${banner}" style="
    position:absolute;
    left:0;
    bottom:0;
    width:100%;
    height:17mm;
    object-fit:cover;
    object-position:center bottom;
  ">

</div>
`;

// =====================================================
// 9. SOMMAIRE ILLUSTRE
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
// 10. INDICATEURS CLES
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

    <div class="overview-block overview-stats">
      <img src="${statsImage}"
           alt="Chiffres clés du territoire">
    </div>

    <div class="overview-block overview-features">
      <img src="${featuresImage}"
           alt="Caractéristiques du territoire">
    </div>

    <div class="overview-block overview-map">
      <img src="${mapImage}"
           alt="Carte du territoire">
    </div>

  </div>

  <div class="intro-footer">
    <span>Source : data.melunvaldeseine.fr</span>
    <span>Agglomération Melun Val de Seine</span>
  </div>
</div>
`;

// =====================================================
// 11. QUATRIEME DE COUVERTURE
// =====================================================

// Conservee a l'identique.

const backCoverHTML = `
<div class="page" style="
  background:${NAVY};
  color:white;
">

  <div style="
    position:absolute;
    top:18mm;
    left:20mm;
    font-size:10pt;
    font-weight:700;
    letter-spacing:1px;
    color:#AFC7E8;
  ">
    AGGLOMÉRATION MELUN VAL DE SEINE
  </div>

  <div style="
    position:absolute;
    top:52mm;
    left:20mm;
    right:20mm;
    text-align:center;
  ">

    <h1 style="
      font-size:31pt;
      font-weight:800;
      margin:0;
      line-height:1.2;
    ">
      Le territoire en données
    </h1>

    <div style="
      width:28mm;
      height:1.5mm;
      background:${RED};
      margin:10mm auto;
    "></div>

    <p style="
      font-size:15pt;
      color:#D8E8FF;
      margin:0;
    ">
      Explorez le panorama interactif
    </p>

    <div style="
      font-size:20pt;
      font-weight:700;
      margin-top:8mm;
    ">
      data.melunvaldeseine.fr
    </div>

    <div style="
      margin-top:7mm;
      font-size:11pt;
      color:#AFC7E8;
    ">
      Une question, une remarque ?
      data@camvs.com
    </div>
  </div>

  <div style="
    position:absolute;
    left:0;
    right:0;
    bottom:0;
    height:78mm;
  ">
    <img src="${banner}" style="
      width:100%;
      height:100%;
      object-fit:cover;
      object-position:center bottom;
    ">
  </div>

  <div style="
    position:absolute;
    left:18mm;
    right:18mm;
    bottom:14mm;
    display:flex;
    align-items:center;
    justify-content:space-between;
  ">
    <img src="${logoData}" class="logo-data">

    <div class="logos">
      <img src="${logoCAMVS}" class="logo-camvs">

      <div class="logo-ue-panel">
        <img src="${logoUE}" class="logo-ue">
      </div>
    </div>
  </div>
</div>
`;

// =====================================================
// 12. GENERATION DES PAGES INSTITUTIONNELLES
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

    const makeHTML = content => `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <style>${css}</style>
      </head>
      <body>${content}</body>
      </html>
    `;

    async function waitImages() {
      await page.evaluate(async () => {
        await document.fonts.ready;

        await Promise.all(
          [...document.images].map(img =>
            img.decode()
          )
        );
      });
    }

    await page.setContent(
      makeHTML(
        coverHTML +
        preambleHTML +
        tocHTML +
        overviewHTML
      ),
      { waitUntil: 'load' }
    );

    await waitImages();

    await page.pdf({
      path: path.join(OUT, '00-introduction.pdf'),
      format: 'A4',
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true
    });

    await page.setContent(
      makeHTML(backCoverHTML),
      { waitUntil: 'load' }
    );

    await waitImages();

    await page.pdf({
      path: path.join(
        OUT,
        '00-quatrieme-couverture.pdf'
      ),
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
// 13. ASSEMBLAGE FINAL
// =====================================================

const finalPDF = await PDFDocument.create();

const introPDF = await PDFDocument.load(
  await fs.readFile(
    path.join(OUT, '00-introduction.pdf')
  )
);

if (introPDF.getPageCount() !== 4) {
  throw new Error(
    'Introduction : 4 pages attendues, ' +
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

// =====================================================
// 14. RUBRIQUES THEMATIQUES
// =====================================================

for (const section of sections) {
  const isPopulation =
    section.number === 1 &&
    section.pages >= 2;

  if (!isPopulation) {
    const copied = await finalPDF.copyPages(
      section.source,
      section.source.getPageIndices()
    );

    for (const page of copied) {
      finalPDF.addPage(page);
    }

    continue;
  }

  // Premiere page Population intacte.
  const [firstPage] = await finalPDF.copyPages(
    section.source,
    [0]
  );

  finalPDF.addPage(firstPage);

  // Deuxieme page Population avec en-tete.
  const sourcePage = section.source.getPage(1);

  const [embedded] = await finalPDF.embedPages(
    [sourcePage]
  );

  const { width, height } = sourcePage.getSize();

  const newPage = finalPDF.addPage([
    width,
    height
  ]);

  newPage.drawPage(embedded, {
    x: 0,
    y: -45,
    width,
    height
  });

  newPage.drawRectangle({
    x: 0,
    y: height - 46,
    width,
    height: 46,
    color: pdfColor(NAVY)
  });

  newPage.drawRectangle({
    x: 0,
    y: height - 46,
    width: 5,
    height: 46,
    color: pdfColor(RED)
  });

  newPage.drawText(
    'DEMOGRAPHIE / Population',
    {
      x: 22,
      y: height - 20,
      size: 12,
      font: boldFont,
      color: rgb(1, 1, 1)
    }
  );

  newPage.drawText(
    'Evolution de la population par commune',
    {
      x: 22,
      y: height - 36,
      size: 9,
      font,
      color: rgb(0.82, 0.9, 1)
    }
  );

  newPage.drawText(
    'Source : donnees du Panorama territorial',
    {
      x: 22,
      y: height - 58,
      size: 8,
      font,
      color: pdfColor('#64748B')
    }
  );

  if (section.pages > 2) {
    const indices = Array.from(
      { length: section.pages - 2 },
      (_, i) => i + 2
    );

    const remaining = await finalPDF.copyPages(
      section.source,
      indices
    );

    for (const page of remaining) {
      finalPDF.addPage(page);
    }
  }
}

// =====================================================
// 15. QUATRIEME DE COUVERTURE
// =====================================================

const backPDF = await PDFDocument.load(
  await fs.readFile(
    path.join(OUT, '00-quatrieme-couverture.pdf')
  )
);

if (backPDF.getPageCount() !== 1) {
  throw new Error(
    'La quatrieme de couverture doit faire une page.'
  );
}

const [backPage] = await finalPDF.copyPages(
  backPDF,
  [0]
);

finalPDF.addPage(backPage);

// =====================================================
// 16. PAGINATION
// =====================================================

const pages = finalPDF.getPages();
const total = pages.length;

for (let index = 2; index < total - 1; index++) {
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
// 17. METADONNEES
// =====================================================

finalPDF.setTitle(
  'Panorama territorial - Melun Val de Seine'
);

finalPDF.setAuthor(
  'Agglomeration Melun Val de Seine'
);

finalPDF.setSubject(
  'Panorama territorial et donnees publiques'
);

await fs.writeFile(
  DEST,
  await finalPDF.save()
);

console.log(`PDF complet cree : ${DEST}`);
console.log(
  `${sections.length} rubriques - ${total} pages`
);
