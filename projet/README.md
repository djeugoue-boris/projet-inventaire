# Projet final Kubernetes : Inventaire

Application trois tiers (frontend Nginx, API Node.js, PostgreSQL) packagée avec Helm, sécurisée (Pod Security « restricted », NetworkPolicies, RBAC), supervisée (Prometheus, Grafana, Loki), scalable (HPA, PDB) et déployée automatiquement (GitHub Actions + GHCR).

## Membres du groupe

- Boris Djeugoue

## Architecture

```
navigateur ──HTTPS──> Ingress nginx (inventaire.local, TLS cert-manager)
                         ├── /     -> Service inventaire-frontend:8080 -> Deployment frontend (2 réplicas)
                         └── /api  -> Service inventaire-api:3000      -> Deployment api (HPA 2 à 6)
                                                                              │ 5432
                                                                              v
                                              Service headless inventaire-postgres -> StatefulSet postgres (PVC 1 Gi)
Prometheus (ns monitoring) ──3000──> api /metrics (ServiceMonitor) ; Fluent Bit -> Loki (logs JSON de l'API)
```

| Composant | Ressources |
|---|---|
| Entrée | Ingress (classe nginx), TLS cert-manager (ClusterIssuer `selfsigned`), routage path-based |
| frontend | Deployment (2 réplicas), Service ClusterIP, ConfigMap (index.html) |
| api | Deployment, Service ClusterIP, HPA (2 à 6), PDB, ServiceAccount, ConfigMap |
| postgres | StatefulSet (1 réplica), Service headless, PVC 1 Gi (volumeClaimTemplates), Secret (créé hors chart) |
| Réseau | NetworkPolicies : deny-all + DNS + ingress→frontend/api, Prometheus→api, api→postgres |
| Observabilité | ServiceMonitor, PrometheusRule (taux d'erreurs + latence p95), dashboard Grafana (JSON) |
| RBAC | ServiceAccount API sans jeton ; ServiceAccount `lecteur` + Role lecture seule |

```
projet/
├── README.md
├── app/                      # API Node.js (code fourni) + Dockerfile
├── chart/inventaire/         # chart Helm unique (un fichier par ressource)
│   ├── Chart.yaml
│   ├── values.yaml
│   ├── values-prod.yaml
│   ├── files/index.html      # page du frontend, injectée par ConfigMap
│   └── templates/
└── observabilite/golden-signals-inventaire.json   # dashboard Grafana
.github/workflows/ci.yaml     # à la racine du dépôt
```

## Installation complète depuis un cluster vide

### 1. Cluster Kind + Calico (identique au TP1)
```bash
kind create cluster --config kind-config.yaml          # disableDefaultCNI, podSubnet 192.168.0.0/16, ports 80/443
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/calico.yaml
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s
```

### 2. Briques du cluster (TP2 et TP3)
```bash
# Ingress Controller nginx
helm upgrade --install ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx \
  -n ingress-nginx --create-namespace -f values-ingress.yaml

# cert-manager + ClusterIssuer auto-signé
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
kubectl apply -f - <<'YAML'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
YAML

# Supervision : kube-prometheus-stack, Loki, Fluent Bit (values du TP3)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add fluent https://fluent.github.io/helm-charts
helm repo update
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack -n monitoring --create-namespace -f values-monitoring.yaml
helm upgrade --install loki grafana/loki -n monitoring -f values-loki.yaml
helm upgrade --install fluent-bit fluent/fluent-bit -n monitoring -f values-fluent-bit.yaml

# metrics-server (requis par le HPA ; sur Kind on ignore le certificat du kubelet)
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system --set 'args={--kubelet-insecure-tls}'
kubectl top nodes   # répond après environ 1 minute
```

### 3. Namespace « restricted » et Secret PostgreSQL (hors du chart, jamais dans Git)
```bash
kubectl create namespace inventaire
kubectl label namespace inventaire pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/enforce-version=latest
kubectl create secret generic inventaire-postgres -n inventaire \
  --from-literal=password="$(openssl rand -base64 24)"
```

### 4. Image de l'API
Normalement construite et poussée par la CI sur GHCR (voir CI/CD). Le package GHCR doit être **public** (GitHub > Packages > inventaire-api > Package settings > Change visibility), sinon il faut un `imagePullSecret` (`api.imagePullSecrets`).

Test local sans CI :
```bash
cd projet/app
docker build -t inventaire-api:dev .
kind load docker-image inventaire-api:dev --name m2-k8s
# puis ajouter à l'installation : --set api.image.repository=inventaire-api --set api.image.tag=dev
```

### 5. Installation de l'application
```bash
cd projet
helm lint chart/inventaire
helm upgrade --install inventaire ./chart/inventaire -n inventaire --create-namespace --reset-values
kubectl get all,pvc,ingress,hpa,networkpolicy -n inventaire
```

Nom d'hôte : ajouter `127.0.0.1 inventaire.local` dans `/etc/hosts` (WSL/Linux) et dans `C:\Windows\System32\drivers\etc\hosts` (navigateur Windows, éditeur lancé en administrateur).

Application : https://inventaire.local (certificat auto-signé : accepter l'avertissement du navigateur).

### 6. Dashboard Grafana
Grafana > Dashboards > New > Import > téléverser `observabilite/golden-signals-inventaire.json` > choisir les datasources Prometheus et Loki.

## Démo (10 minutes)

**1. Installation**
```bash
helm upgrade --install inventaire ./chart/inventaire -n inventaire --create-namespace --reset-values
kubectl get all,pvc,ingress,hpa,networkpolicy -n inventaire
```

**2. Application en HTTPS** : ouvrir https://inventaire.local, ajouter un article.
```bash
curl -sI http://inventaire.local | head -3                  # 308 : redirection vers HTTPS
curl -sk https://inventaire.local/api/items                 # l'article ajouté
curl -sk -o /dev/null -w "%{http_code}\n" https://inventaire.local/metrics   # 404 : /metrics non exposé
```

**3. Persistance**
```bash
kubectl -n inventaire delete pod inventaire-postgres-0
kubectl -n inventaire get pods -w          # inventaire-postgres-0 recréé, même PVC data-inventaire-postgres-0
curl -sk https://inventaire.local/api/items  # l'article est toujours là
```

**4. Flux interdit / flux autorisé**
```bash
# Interdit : un Pod d'un autre namespace vers l'API -> timeout
kubectl run intrus -n default -i --rm --restart=Never --image=busybox:1.36 -- \
  wget -qO- -T 3 http://inventaire-api.inventaire:3000/api/health
# Autorisé : via l'Ingress
curl -sk https://inventaire.local/api/health
```
Sécurité complémentaire :
```bash
kubectl auth can-i list pods -n inventaire --as=system:serviceaccount:inventaire:lecteur      # yes
kubectl auth can-i delete pods -n inventaire --as=system:serviceaccount:inventaire:lecteur    # no
kubectl auth can-i get secrets -n inventaire --as=system:serviceaccount:inventaire:lecteur    # no
kubectl get ns inventaire --show-labels      # pod-security.kubernetes.io/enforce=restricted
```

**5. Test de charge : le HPA monte puis redescend** (3 ou 4 terminaux)
```bash
while true; do curl -sk "https://inventaire.local/api/cpu?ms=200" > /dev/null; done
kubectl -n inventaire get hpa -w
```
Dashboard « Golden Signals - Inventaire » : trafic, CPU et panneau « Replicas API (HPA) » montent. Arrêter la charge (Ctrl+C) : retour à 2 réplicas après environ 5 minutes (fenêtre de stabilisation du HPA).

**6. Alerte et logs**
```bash
while true; do curl -sk "https://inventaire.local/api/cpu?ms=1000" > /dev/null; done
```
La latence p95 dépasse 500 ms : `InventaireApiLatenceElevee` passe Pending puis Firing (Prometheus > Alerts, Alertmanager). Logs correspondants dans Grafana > Explore > Loki :
```
{namespace="inventaire", app="inventaire-api"} | json | path="/api/cpu"
{namespace="inventaire", app="inventaire-api"} | json | level="error"
```

**7. CI/CD** : modifier `projet/app/server.js` (par exemple le message de démarrage), commit et push. Le workflow build, scanne (Trivy), pousse sur GHCR et commite le nouveau tag dans `values.yaml`. Puis :
```bash
git pull
helm upgrade --install inventaire ./chart/inventaire -n inventaire --reset-values
kubectl -n inventaire get deploy inventaire-api -o jsonpath='{.spec.template.spec.containers[0].image}'
```

**Rollback Helm**
```bash
helm history inventaire -n inventaire
helm rollback inventaire <révision> -n inventaire
```

## Choix techniques

- **Un chart unique, un fichier par ressource**, noms et labels communs dans `_helpers.tpl` (`app.kubernetes.io/name`, `instance`, `component`), plus un label court `app` (ex. `inventaire-api`) utilisé par Fluent Bit pour étiqueter les logs dans Loki.
- **Aucune valeur en dur** : images, tags, réplicas, ressources, host, taille du PVC, seuils HPA et seuils d'alerte viennent de `values.yaml`. Blocs activables : `api.autoscaling.enabled`, `api.pdb.enabled`, `ingress.enabled`, `networkPolicies.enabled`, `monitoring.serviceMonitor.enabled`, `monitoring.prometheusRule.enabled`, `rbac.lecteur.enabled`.
- **values-prod.yaml** surcharge réplicas, ressources, bornes du HPA, PDB, taille du stockage, host et ClusterIssuer.
- **Secret hors du chart** (`kubectl create secret`), référencé par `postgres.existingSecret` et injecté par `valueFrom.secretKeyRef` dans l'API et PostgreSQL.
- **Pod Security restricted** : `securityContext` commun (`runAsNonRoot`, pas d'escalade, `capabilities: drop ALL`, `seccompProfile: RuntimeDefault`, `readOnlyRootFilesystem: true`) sur tous les conteneurs. Images non-root : nginx-unprivileged (101, port 8080), API (USER 1000), postgres (`runAsUser`/`fsGroup` 999). Dossiers d'écriture en `emptyDir` (`/tmp` pour nginx ; `/var/run/postgresql` et `/tmp` pour postgres ; `PGDATA` dans un sous-dossier du volume).
- **ConfigMap du frontend versionnée par checksum** : une modification de `files/index.html` (ou de la ConfigMap de l'API) redéploie automatiquement les Pods.
- **Zero-trust réseau** : deny-all puis uniquement les flux de l'architecture cible. `/metrics` reste joignable par Prometheus (NetworkPolicy) mais n'est routé par aucune règle de l'Ingress.
- **RBAC** : ServiceAccount de l'API avec `automountServiceAccountToken: false` ; ServiceAccount `lecteur` lié à un Role en lecture seule (sans accès aux Secrets).
- **Deux alertes** : taux d'erreurs 5xx > 5 % et latence p95 > 500 ms (la seconde se démontre de façon fiable avec la route `/api/cpu`).
- **Dashboard Golden Signals** : latence p50/p95/p99, trafic, erreurs (stat, seuil 5 %), saturation (CPU/mémoire par Pod), réplicas du HPA, logs d'erreurs Loki. La route `/metrics` est exclue des calculs de latence et de trafic.
- **CI** : le nom de l'image est calculé en minuscules depuis le propriétaire du dépôt ; `helm lint` est exécuté avant le build ; le tag (SHA du commit) et le dépôt d'image sont mis à jour dans `values.yaml` avec `yq`.

## Difficultés rencontrées

- **Pod Security restricted** : un Pod sans `seccompProfile` ou sans utilisateur numérique est refusé ; le message apparaît dans les événements du ReplicaSet (`kubectl describe rs`), pas dans `kubectl get pods`.
- **`readOnlyRootFilesystem`** : PostgreSQL et nginx doivent écrire (socket, fichiers temporaires) ; résolu avec des `emptyDir` sur les seuls dossiers nécessaires.
- **Image GHCR privée par défaut** : `ImagePullBackOff` tant que le package n'est pas rendu public.
- **Lecture des percentiles** : `histogram_quantile` interpole à l'intérieur des buckets, donc le p95 est une estimation qui dépend du découpage (observé au TP3 : ~2,3 s affichés pour des requêtes d'~1 s).
- **Logs dans Loki** : Fluent Bit ne lit que les lignes écrites après son déploiement (pas l'historique).
- **port-forward** qui se coupe (veille, redémarrage de Pod) : il suffit de le relancer.

## Question : pourquoi le commit automatique ne relance-t-il pas le workflow en boucle ?

Pour deux raisons :
1. **GitHub ne déclenche pas de nouveau workflow pour un push réalisé avec le `GITHUB_TOKEN`** du workflow lui-même : c'est une protection native contre les exécutions récursives (seuls `workflow_dispatch` et `repository_dispatch` font exception).
2. **Le filtre `paths: ["projet/app/**"]`** : le commit de la CI ne modifie que `projet/chart/inventaire/values.yaml`, qui est hors de ce filtre. Même avec un autre jeton (PAT), il ne correspondrait pas au déclencheur.

## Check-list avant rendu

- [ ] `helm lint chart/inventaire` sans erreur
- [ ] Installation testée sur un cluster recréé de zéro
- [ ] Aucun mot de passe en clair dans le dépôt (`git log -p | grep -i password` ne renvoie que des noms de variables : `DB_PASSWORD`, `POSTGRES_PASSWORD`, `secretKey: password`)
- [ ] Tous les Pods acceptés en restricted, aucun en CrashLoopBackOff
- [ ] Dashboard JSON et PrometheusRule présents dans le dépôt
- [ ] Dernier run du workflow vert
- [ ] README complet

## Difficultés rencontrées (compléments)

- **Action Trivy introuvable** : `aquasecurity/trivy-action@0.28.0` n'était plus disponible (`unable to resolve action`). Remplacée par l'image officielle `aquasec/trivy` (version figée), en conservant le comportement bloquant sur les CRITICAL.
- **Scan Trivy bloquant (il a fonctionné)** : CVE-2026-59873 (CRITICAL) dans `tar`, dépendance de npm embarqué dans l'image Node. Correction : Dockerfile multi-étapes, suppression de npm/npx/yarn/corepack de l'image finale (réduction de la surface d'attaque) et passage à Node 22 (Node 20 n'étant plus maintenu).
- **Valeurs Helm reconduites** : un `helm upgrade` sans option de valeurs réutilise celles de la révision précédente (ici les `--set` du test local). Solution : `--reset-values` pour repartir du `values.yaml` mis à jour par la CI.
- **Cluster Kind après redémarrage de Docker** : redirection de port de l'API bloquée (`connection reset by peer`, corrigée par `docker restart m2-k8s-control-plane`), puis échange d'adresses IP entre deux nœuds (Calico en conflit d'IP, control-plane NotReady). Correction : relancer les nœuds dans l'ordre pour qu'ils récupèrent leurs IP d'origine, puis redémarrer les Pods Calico.
