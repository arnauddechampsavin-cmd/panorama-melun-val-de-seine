
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const URL =
  'https://data.melunvaldeseine.fr/pages/test-pano-arnaud/';

const OUT = 'output';

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true
});

const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 }
});

page.setDefaultTimeout(30000);

try {
  // 1. Ouvrir le panorama

await page.goto(URL, {
  waitUntil: 'domcontentloaded',
  timeout: 90000
});

// Attendre le chargement du panorama
await page.locator('.sidebar-nav .cl-dropdown')
  .first().waitFor();

// Gérer la fenêtre de consentement aux cookies
const cookieModal = page.locator(
  'ods-manage-cookies-preferences-modal'
);

if (await cookieModal.isVisible().catch(() => false)) {

  console.log('Fenêtre cookies détectée');

  // Essayer de refuser les cookies facultatifs
  const refuseButton = page.getByRole('button', {
    name: /tout refuser|refuser tout|reject all|refuse all/i
  });

  if (await refuseButton.isVisible().catch(() => false)) {
    await refuseButton.click();
    console.log('Cookies facultatifs refusés');
  }
}

// Vérifier que la fenêtre ne bloque plus la page
await page.waitForTimeout(1000);

  // 2. Découvrir automatiquement les rubriques
  const groups = await page
    .locator('.sidebar-nav .cl-dropdown')
    .evaluateAll(nodes => nodes.map((node, index) => ({
      index,
      title: node.querySelector('.cl-dropdown-button')
        ?.textContent?.trim() || `Thème ${index + 1}`,
      items: [...node.querySelectorAll('.cl-dropdown-item')]
        .map((item, itemIndex) => ({
          itemIndex,
          title: item.textContent.trim()
        }))
    })));

  console.log('Rubriques détectées :', groups);

  await fs.writeFile(
    path.join(OUT, 'rubriques.json'),
    JSON.stringify(groups, null, 2)
  );

  // 3. Parcourir les sous-thématiques
  let counter = 0;

  for (const group of groups) {
    for (const item of group.items) {

      const menu = page
        .locator('.sidebar-nav .cl-dropdown')
        .nth(group.index);

      const button = menu.locator('.cl-dropdown-button');

      // Ouvrir le menu seulement s'il est fermé
      const isOpen = await button.evaluate(el =>
        el.classList.contains('cl-dropdown-button-open')
      );

      if (!isOpen) {
        await button.click();
      }

      await menu.locator('.cl-dropdown-item')
        .nth(item.itemIndex).click();

      // 4. Attendre le contenu de la rubrique
      await page.locator(
        '.content-area > .content-section:visible'
      ).first().waitFor();

      await page.waitForTimeout(2500);

      // 5. Générer le PDF A4 paysage
      const filename =
        `${String(++counter).padStart(2, '0')}-` +
        `${group.index + 1}-${item.itemIndex + 1}.pdf`;

      await page.pdf({
        path: path.join(OUT, filename),
        format: 'A4',
        landscape: true,
        printBackground: true,
        preferCSSPageSize: true
      });

      console.log(`PDF créé : ${filename}`);
    }
  }

  console.log(`${counter} sous-thématiques traitées.`);

} finally {
  await browser.close();
}
