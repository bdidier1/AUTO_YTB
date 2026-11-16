# AUTO YTB

Site local pour publier sur YouTube des vidéos récupérées sur TikTok, Instagram, X/Twitter, Facebook, YouTube, etc.
Chaque vidéo est automatiquement convertie en **4K vertical 2160×3840 à 60 i/s** (même logique que `script_4k_shorts` : bandes noires seulement si la source n'est pas en 9:16).

## Lancer

Double-clique sur **`LANCER.bat`**. Le site s'ouvre sur http://127.0.0.1:8765.
Ferme la fenêtre noire pour arrêter.

Il faut **ffmpeg** (`winget install Gyan.FFmpeg`) et **Python 3.10+**. Les deux sont déjà installés sur ce PC.

---

## Connecter tes comptes YouTube (à faire une seule fois, ~5 min)

Google impose de créer un « projet » gratuit qui donne à l'appli le droit de publier pour toi.

### 1. Créer le projet
1. Va sur https://console.cloud.google.com et connecte-toi avec ton compte Google.
2. En haut à gauche, clique sur le sélecteur de projet → **Nouveau projet** → nom : `AUTO YTB` → **Créer**, puis sélectionne-le.

### 2. Activer les deux API
Menu ☰ → **API et services** → **Bibliothèque**. Cherche et clique **Activer** sur :
- **YouTube Data API v3**
- **YouTube Analytics API**

### 3. Écran de consentement
Menu ☰ → **API et services** → **Écran de consentement OAuth** (ou « Google Auth Platform »).
1. **Commencer** → nom de l'appli : `AUTO YTB`, e-mail d'assistance : le tien.
2. Audience : **Externe**. E-mail de contact : le tien. Accepte et **Créer**.
3. Onglet **Audience** → **Publier l'application** → Confirmer.
   *Important : en mode « Test », Google déconnecte tes comptes tous les 7 jours. En mode « Production », ça reste connecté.*

### 4. Créer l'identifiant
1. Onglet **Clients** (ou « Identifiants ») → **Créer un client** / **Créer des identifiants → ID client OAuth**.
2. Type d'application : **Application de bureau**. Nom : `AUTO YTB` → **Créer**.
3. Clique **Télécharger le JSON**.
4. Renomme le fichier en **`client_secret.json`** et mets-le dans **`AUTO_YTB\data\`**.

### 5. Connecter une chaîne
1. Lance `LANCER.bat` → menu du profil en haut à droite → **Ajouter un compte**.
2. Choisis le compte Google, puis **la chaîne** si tu en as plusieurs.
3. Google affiche « Google n'a pas validé cette application » : c'est normal, c'est ta propre appli.
   Clique **Paramètres avancés** → **Accéder à AUTO YTB** → coche **toutes** les cases → **Continuer**.
4. Recommence l'étape 5 pour chaque chaîne. Ensuite tu passes de l'une à l'autre avec le menu déroulant en haut à droite.

### ⚠ Si tes vidéos restent bloquées en privé
Google peut limiter en « privé » les vidéos envoyées par un projet qui n'a pas été **audité par YouTube**. Cette règle concerne les projets créés depuis 2020, et aucune appli ne peut la contourner.
Si ça t'arrive (la vidéo ne passe jamais en public à l'heure prévue), remplis le formulaire d'audit gratuit :
https://support.google.com/youtube/contact/yt_api_form
(« YouTube API Services - Audit and Quota Extension Form »). Décris l'usage : outil personnel pour publier sur tes propres chaînes.

---

## Utilisation

**Menu du profil (en haut à droite)** : profil de la chaîne, statistiques, vidéos en ligne, gestion des comptes, changement de compte et ajout d'un compte.

**Publier** : colle un lien. La vidéo passe par 3 étapes :
1. **Téléchargement & 4K** : la vidéo est téléchargée, puis convertie en 2160×3840 à 60 i/s. La résolution finale est vérifiée et affichée.
2. **Aperçu & découpage** : glisse la souris sur la barre bleue sous la vidéo pour couper un passage. Il devient rouge et la suite est recollée automatiquement. Tire les poignées blanches pour choisir le début et la fin. Clique sur un passage rouge pour le remettre. La lecture saute déjà les passages coupés. Clique ensuite sur « L'aperçu me va » : la 4K est refaite avec ton découpage.
3. **Mise en ligne** :
   - **Titre** : repris du texte affiché au début de la vidéo, lu par l'OCR de Windows. Sinon, le titre d'origine est utilisé.
   - **Description** : reprise de la vidéo d'origine, avec ses hashtags écrits directement dedans. Les suggestions (tirées de Shorts similaires sur YouTube) s'ajoutent en un clic à la fin de la description.
   - **Vérifications** comme dans YouTube Studio : qualité, format Short, titre, hashtags, filigrane TikTok, risque « contenu réutilisé », droits d'auteur.
   - **Monétisation** : l'éligibilité de la chaîne, avec les seuils du Programme Partenaire.
   - **Date** : programmée par défaut **aujourd'hui à 16h30** (demain si l'heure est passée).

**Vidéos en ligne** : toutes les vidéos de la chaîne active (publiées, programmées, privées), avec les vues, j'aime et commentaires en direct, et les problèmes éventuels (blocage de droits d'auteur, refus). Pour chaque vidéo, tu peux :
- changer la date de programmation ;
- publier tout de suite ;
- modifier le titre, la description et les tags ;
- supprimer la vidéo ;
- ouvrir ses **statistiques détaillées** : vues, durée moyenne regardée, % regardé, partages, abonnés gagnés, revenus, graphique par jour, sources de trafic (flux Shorts, recherche…) et pays.

**Statistiques** (menu du profil) : chiffres globaux de la chaîne. Les chiffres « Analytics » ont 2 à 3 jours de retard sur YouTube. Les compteurs marqués « en direct » sont identiques à ceux de YouTube.

**Profil** (menu du profil) : description, mots-clés, pays et bannière. Le nom et la photo de profil se changent dans YouTube Studio (limite imposée par YouTube).

**Instagram ou contenus privés** : si un téléchargement demande une connexion, exporte les cookies de ton navigateur au format Netscape (extension « Get cookies.txt LOCALLY ») dans `data\cookies.txt`.

---

## Sécurité
- Le site n'écoute que sur `127.0.0.1` : il est invisible depuis le réseau et Internet.
- Les jetons d'accès Google sont **chiffrés** (AES/Fernet) dans `data\autoytb.db`, avec la clé `data\secret.key`.
  **Ne partage jamais le dossier `data\`** : il contient tes accès.
- Protections contre les sites malveillants qui voudraient piloter l'appli depuis ton navigateur : anti-CSRF, anti-DNS-rebinding, CSP stricte, aucun contenu injecté en HTML.
- La connexion Google utilise OAuth + PKCE : l'appli ne voit jamais ton mot de passe.
- « Déconnecter » un compte révoque aussi l'accès chez Google.

## Dossiers
- `data\videos\` : vidéos en cours de traitement. Elles sont supprimées automatiquement dès que la vidéo est en ligne. Il ne reste qu'une petite miniature, effacée quand tu retires la carte.
- `data\client_secret.json` : ton identifiant Google (étape 4)
- `app\` : serveur (Python / FastAPI) · `static\` : interface
