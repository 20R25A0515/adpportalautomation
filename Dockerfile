# Use official Playwright image which has all browser dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.44.1-jammy

# Set working directory
WORKDIR /app

# Copy package files first (better Docker layer caching)
COPY package*.json ./

# Install Node.js dependencies (skip postinstall since browsers are already in the image)
RUN npm ci --ignore-scripts

# Copy application source code
COPY . .

# Expose the port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production

# Start the server
CMD ["node", "server.js"]
