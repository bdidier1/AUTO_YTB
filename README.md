# AUTO YTB

Outil personnel, installé en local, pour **publier sur YouTube des vidéos récupérées sur TikTok, Instagram, X, Facebook ou YouTube**.

Chaque vidéo est téléchargée, convertie automatiquement en **4K vertical (2160×3840) à 60 i/s**, découpée si besoin dans un aperçu, puis mise en ligne avec un titre lu à l'écran par OCR, la description d'origine et ses hashtags, et une date de programmation.

## Fonctionnalités

- **Publication en 3 étapes** : téléchargement et conversion 4K, aperçu avec découpage à la souris, mise en ligne
- **Vérifications façon YouTube Studio** : qualité, format Short, titre, hashtags, filigrane, risque de contenu réutilisé
- **Plusieurs chaînes** connectées en OAuth, avec un menu pour passer de l'une à l'autre
- **Vidéos en ligne** : programmation, publication immédiate, modification, suppression, statistiques détaillées (vues, rétention, revenus, sources de trafic, pays)
- **Statistiques et profil** de la chaîne (YouTube Analytics)

## Technologies

Python, FastAPI, API YouTube Data v3 et YouTube Analytics, OAuth 2.0 + PKCE, yt-dlp, ffmpeg, OCR de Windows (WinRT), SQLite, interface en HTML/CSS/JavaScript.

## Sécurité

- Le serveur n'écoute que sur `127.0.0.1`.
- Les jetons Google sont chiffrés (Fernet) ; le dossier `data/` (jetons, clé, cookies) n'est **jamais versionné**.
- Anti-CSRF, anti-DNS-rebinding, CSP stricte, aucun contenu injecté en HTML.

## Installation et utilisation

Le guide complet (création du projet Google Cloud, connexion des chaînes, utilisation) est dans [LISEZMOI.md](LISEZMOI.md).
