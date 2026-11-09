# SMSM Traduction

Service de traduction de l'église, spécialisé arabe ↔ français (et plus de 80 langues), **gratuit** :

- **Hébergement** : Cloudflare Workers, offre gratuite, toujours en ligne, adresse en `https://smsm-traduction.<ton-nom>.workers.dev`.
- **IA gratuite, sans aucune clé obligatoire** :
  - **OVHcloud AI Endpoints**, en accès anonyme. L'appel part du navigateur de chaque traducteur, donc chacun a son propre quota : 2 requêtes par minute et par modèle, sur 3 modèles. Plus il y a de traducteurs, plus le volume total est grand.
  - **Cloudflare Workers AI**, inclus, sans clé : environ 30 pages par jour.
  - En option, des clés gratuites ajoutent du volume et de la qualité : Mistral, Cerebras, Groq, NVIDIA (voir le tableau plus bas).
- **Lecture des scans et photos (OCR)** : Tesseract, open source. La lecture se fait dans le navigateur du traducteur, en arabe, français et anglais : gratuite, illimitée, sans clé.

  | Moteur facultatif | Gratuit | Clé |
  |---|---|---|
  | Mistral | crédits ou volume mensuel gratuits (variable), excellent en français | console.mistral.ai, vérification par SMS. Les textes peuvent servir à l'entraînement de Mistral. |
  | Cerebras | variable selon la période | cloud.cerebras.ai |
  | Groq (Llama 3.3 70B) | environ 1 000 requêtes par jour, et lecture IA des scans (meilleure mise en page que l'OCR) | console.groq.com |
  | NVIDIA (Llama 3.3 70B) | crédits gratuits | build.nvidia.com |

  Les offres gratuites changent souvent. L'ordre et l'activation des moteurs se règlent dans **Équipe**.
- **Données** : comptes, lexique, propositions de termes et réglages sont stockés dans Cloudflare KV (gratuit).

## Mettre en ligne (et mettre à jour)

Double-clique sur `mettre-en-ligne.command`. Le script :

1. installe les outils,
2. te connecte à Cloudflare (compte gratuit),
3. publie le site,
4. te demande les clés gratuites des moteurs (Mistral, Cerebras, Groq, NVIDIA).

À la première visite du site, crée ton compte administrateur. Ajoute ensuite les traducteurs dans **Équipe**.

Pour publier une modification, relance simplement `mettre-en-ligne.command`.

## Parcours

- **Accueil** : choisir entre traduire un document ou un texte.
- **Document** : 5 étapes.
  1. Fichier.
  2. Réglages.
  3. Traduction.
  4. Relecture, où chaque paragraphe se corrige.
  5. Téléchargement, avec Word, PowerPoint ou Excel au même format et la même mise en page.
- **Texte** : traduction modifiable directement, contrôle qualité, export.
- **Lexique** : le référentiel du diocèse.
  - Les traducteurs **proposent** des termes ; l'administrateur les **valide**.
  - Import et export Excel.
  - Consignes du projet.
- **Équipe** (administrateur) : comptes des traducteurs et choix du moteur.
- **Mon compte** : changer son mot de passe.

## Limites à connaître

- Si tous les moteurs atteignent leur limite le même jour, le site l'indique clairement et reprend dès qu'un moteur redevient disponible.
- La qualité des modèles open source est bonne mais en dessous des meilleurs modèles payants sur les textes théologiques : la relecture reste indispensable.
- L'OCR gratuit lit bien le texte imprimé. Les tableaux complexes et l'écriture manuscrite passent mieux avec une clé Groq ou Mistral.

## Test local

```bash
npm install
npx wrangler dev --var MOCK_ENGINE:1   # moteur factice, sans quota
```
