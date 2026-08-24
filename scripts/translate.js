const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

const localesDir = path.join(__dirname, '..', 'locales');
const enPath = path.join(localesDir, 'en.json');
const targetLangs = ['hi', 'ta', 'te', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'ur', 'or', 'as'];

let enData = {};
try {
  enData = JSON.parse(fs.readFileSync(enPath, 'utf8'));
} catch (err) {
  console.error('Failed to read locales/en.json', err);
  process.exit(1);
}

const keys = Object.keys(enData);
const values = Object.values(enData);

// Find all placeholders in a string
function getPlaceholders(str) {
  const regex = /\{[^}]+\}/g;
  const matches = str.match(regex);
  return matches || [];
}

async function translate() {
  console.log(`Starting translation for ${keys.length} keys...`);
  
  const auth = new GoogleAuth({
    keyFilename: path.join(__dirname, '..', 'credentials', 'cleanair-clear-streets-b2e96f18917e.json'),
    scopes: ['https://www.googleapis.com/auth/cloud-translation']
  });

  const client = await auth.getClient();
  const tokenInfo = await client.getAccessToken();
  const token = tokenInfo.token;

  if (!token) {
    console.error('Failed to get access token using service account');
    process.exit(1);
  }

  // Google Project ID from the service account is required for Translation API v3, but v2 with Bearer token is accepted.
  // Actually, Translation API v2 with OAuth token needs to know the project.
  // We can just use the project ID from the auth client.
  const projectId = await auth.getProjectId();
  
  const results = {};

  for (const lang of targetLangs) {
    console.log(`\nTranslating to ${lang}...`);
    try {
      // Use v3 API for OAuth authentication
      const response = await fetch(`https://translate.googleapis.com/v3/projects/${projectId}:translateText`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: values,
          targetLanguageCode: lang,
          sourceLanguageCode: 'en',
          mimeType: 'text/plain',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error from Google API for ${lang}:`, response.status, errorText);
        continue;
      }

      const data = await response.json();
      const translations = data.translations;

      const newLocaleData = {};
      let mangledCount = 0;

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const originalValue = values[i];
        const translatedValue = translations[i].translatedText;

        // Check for mangled placeholders
        const originalPlaceholders = getPlaceholders(originalValue);
        for (const p of originalPlaceholders) {
          if (!translatedValue.includes(p)) {
            console.warn(`[WARNING] Placeholder mangled in ${lang} for key '${key}': Original='${originalValue}', Translated='${translatedValue}'`);
            mangledCount++;
          }
        }

        newLocaleData[key] = translatedValue;
      }

      if (mangledCount > 0) {
        console.log(`Flagged ${mangledCount} mangled placeholders in ${lang}`);
      }

      // Write file
      const outPath = path.join(localesDir, `${lang}.json`);
      fs.writeFileSync(outPath, JSON.stringify(newLocaleData, null, 2), 'utf8');
      
      // Save for diff check later
      results[lang] = newLocaleData;
      
      console.log(`Successfully wrote ${outPath}`);
    } catch (err) {
      console.error(`Failed to process ${lang}:`, err);
    }
  }

  // Diff summary
  console.log('\n--- Diff Summary ---');
  for (const lang of targetLangs) {
    const langData = results[lang];
    if (!langData) {
      console.log(`[${lang}]: Failed to generate entirely.`);
      continue;
    }
    
    const missingKeys = keys.filter(k => !(k in langData));
    if (missingKeys.length > 0) {
      console.log(`[${lang}]: Missing keys: ${missingKeys.join(', ')}`);
    } else {
      console.log(`[${lang}]: All ${keys.length} keys present.`);
    }
  }
}

translate();
