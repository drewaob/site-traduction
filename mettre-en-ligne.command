#!/bin/bash
# SMSM Traduction : mise en ligne gratuite sur Cloudflare (à relancer pour chaque mise à jour)
cd "$(dirname "$0")"
echo ""
echo "=== SMSM Traduction : mise en ligne ==="
echo ""
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js est nécessaire. Installe la version LTS depuis https://nodejs.org puis relance ce fichier."
  open "https://nodejs.org"; read -p "Appuie sur Entrée pour fermer."; exit 1
fi
[ -d node_modules ] || { echo "Installation des outils (une seule fois)…"; npm install --no-fund --no-audit || exit 1; }

echo "1/3  Connexion à Cloudflare : une page va s'ouvrir dans ton navigateur."
echo "     Crée un compte gratuit si besoin, puis clique sur « Allow »."
npx wrangler whoami 2>/dev/null | grep -q "associated with the email" || npx wrangler login || exit 1

echo ""
echo "2/3  Envoi du site…"
npx wrangler deploy 2>&1 | tee .deploy.log
URL=$(grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' .deploy.log | head -1)
if [ -z "$URL" ]; then
  echo ""; echo "La mise en ligne n'a pas abouti. Envoie une capture de cette fenêtre à Claude."
  read -p "Appuie sur Entrée pour fermer."; exit 1
fi

echo ""
echo "3/3  (Facultatif) Le site marche déjà SANS clé : OVH anonyme + Cloudflare + lecture des scans gratuite."
echo "     Des clés gratuites ajoutent du volume. Appuie sur Entrée pour passer chaque question."
SECRETS=$(npx wrangler secret list 2>/dev/null)
ask_key () {
  NAME=$1; LABEL=$2; SITE=$3
  if echo "$SECRETS" | grep -q "\"$NAME\""; then echo "     • $LABEL : déjà enregistrée."; return; fi
  echo ""; echo "     • $LABEL — $SITE"
  read -p "       Clé $LABEL : " KEY
  if [ -n "$KEY" ]; then printf "%s" "$KEY" | npx wrangler secret put "$NAME" >/dev/null && echo "       Enregistrée."; fi
}
ask_key MISTRAL_API_KEY  "Mistral"  "https://console.mistral.ai/api-keys (offre gratuite « Experiment », vérification par téléphone)"
ask_key CEREBRAS_API_KEY "Cerebras" "https://cloud.cerebras.ai (environ 1 million de jetons gratuits par jour)"
ask_key GROQ_API_KEY     "Groq"     "https://console.groq.com/keys (lit aussi les scans)"
ask_key NVIDIA_API_KEY   "NVIDIA"   "https://build.nvidia.com (crédits gratuits)"

echo ""
echo "✅ Le site est en ligne : $URL"
echo "   À la première visite, crée ton compte administrateur, puis ajoute les traducteurs dans « Équipe »."
open "$URL"
read -p "Appuie sur Entrée pour fermer."
