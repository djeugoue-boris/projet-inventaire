# Etape 1 : installation des dependances (npm n'est present que dans cette etape)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Etape 2 : image finale minimale, sans gestionnaire de paquets
FROM node:22-alpine
# npm, npx, yarn et corepack sont inutiles a l'execution et embarquent des dependances vulnerables
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY server.js ./
# Utilisateur numerique : indispensable pour runAsNonRoot
USER 1000
EXPOSE 3000
CMD ["node", "server.js"]
