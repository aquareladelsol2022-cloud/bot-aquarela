FROM node:20

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .
RUN npm run build

# Run the app
CMD [ "npm", "start" ]
