# SMSM Traduction

Site de traduction de l'église, spécialisé **arabe ↔ français**, et plus de 80 autres langues. **Entièrement gratuit, sans clé ni compte.**

- **Traduction** : IA open source d'[OVHcloud AI Endpoints](https://endpoints.ai.cloud.ovh.net/) en accès anonyme.
  - L'appel part du navigateur de chaque traducteur, donc chacun a son propre quota : 2 requêtes par minute et par modèle.
  - Le site répartit le travail entre les modèles disponibles et gère la file d'attente.
- **Lecture des scans et photos (OCR)** : Tesseract, open source, dans le navigateur. Arabe, français et anglais, sans limite.
- **Fichiers** : Word, PowerPoint et Excel ressortent au même format et avec la même mise en page. PDF, scans, texte et HTML sont reconstruits.
- **Lexique du diocèse** : `site/data/catechese.json` (143 termes et 16 conventions), appliqué automatiquement.
- **Hébergement** : GitHub Pages, gratuit. Publication automatique à chaque modification de `main`, via `.github/workflows/pages.yml`.

## Structure

| Dossier | Contenu |
|---|---|
| `site/` | Le site publié (une page `index.html` + `data/catechese.json`) |
| `serveur-cloudflare/` | Version avec serveur, à utiliser seulement si OVH bloque les appels depuis le navigateur, ou pour avoir des comptes et un lexique partagé en direct |

## Mettre à jour le lexique pour toute l'équipe

1. Sur le site : **Lexique → Exporter le lexique** (Excel).
2. Converti en JSON, il remplace `site/data/catechese.json`. Le site se met à jour tout seul en 1 à 2 minutes.

## Limites

- Le quota gratuit OVH est de 2 requêtes par minute et par modèle, **par connexion internet**. Un long document prend donc quelques minutes, mais se termine sans erreur.
- La qualité des modèles open source est bonne : la relecture reste indispensable pour les textes théologiques.
- Le site est public pour qui connaît l'adresse. Il ne stocke aucun texte : tout reste dans le navigateur, et les textes sont envoyés à OVH pour être traduits.
