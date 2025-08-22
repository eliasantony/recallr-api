# Architecture

This document outlines the architecture of the recipescraper project.

## Overview

The project consists of several modules that work together to scrape recipe data from various sources, process it, and store it. The main components are:

- **Scraper:** Responsible for fetching and extracting recipe data from websites and other sources.
- **Pipeline:** Orchestrates the data processing workflow, including cleaning, transforming, and enriching the scraped data.
- **Database:** Handles storing and retrieving recipe data.
- **API Server:** Provides an interface for accessing the scraped and processed recipe data.
- **Worker:** Executes background tasks, such as long-running scraping jobs.
- **GCS:** Handles interactions with Google Cloud Storage for storing data.
- **Gemini:** Integrates with the Gemini API for enhanced data processing.
- **Migration:** Manages database schema changes.
- **Video:** Handles video processing tasks.

## Modules

### 1. `scraper.mjs`

- **Purpose:** Fetches recipe data from various online sources.
- **Responsibilities:**
  - Crawls websites to identify recipe pages.
  - Extracts relevant information such as ingredients, instructions, and metadata.
  - Handles different website structures and formats.
- **Dependencies:** None

### 2. `pipeline.mjs`

- **Purpose:** Processes and transforms the scraped recipe data.
- **Responsibilities:**
  - Cleans the extracted data to remove inconsistencies and errors.
  - Transforms the data into a standardized format.
  - Enriches the data with additional information, such as nutritional values or cuisine types.
- **Dependencies:** None

### 3. `db.mjs`

- **Purpose:** Manages the database connection and provides functions for storing and retrieving recipe data.
- **Responsibilities:**
  - Connects to the database.
  - Defines the database schema.
  - Implements functions for creating, reading, updating, and deleting recipe data.
- **Dependencies:** None

### 4. `server.mjs`

- **Purpose:** Exposes the processed recipe data through an API.
- **Responsibilities:**
  - Defines API endpoints for accessing recipe data.
  - Handles requests and responses.
  - Implements authentication and authorization.
- **Dependencies:** `db.mjs`

### 5. `worker.mjs`

- **Purpose:** Executes background tasks, such as long-running scraping jobs.
- **Responsibilities:**
  - Receives tasks from a queue.
  - Performs the requested tasks, such as scraping a website or processing a large dataset.
  - Updates the database with the results.
- **Dependencies:** `scraper.mjs`, `pipeline.mjs`, `db.mjs`

### 6. `gcs.mjs`

- **Purpose:** Handles interactions with Google Cloud Storage (GCS).
- **Responsibilities:**
  - Uploads and downloads files to/from GCS.
  - Manages GCS buckets and objects.
- **Dependencies:** None

### 7. `gemini.mjs`

- **Purpose:** Integrates with the Gemini API for enhanced data processing.
- **Responsibilities:**
  - Sends requests to the Gemini API for tasks such as text summarization or image recognition.
  - Processes the responses from the Gemini API.
- **Dependencies:** None

### 8. `migrate.mjs`

- **Purpose:** Manages database schema changes.
- **Responsibilities:**
  - Applies database migrations to update the schema.
  - Rolls back migrations if necessary.
- **Dependencies:** `db.mjs`

### 9. `video.mjs`

- **Purpose:** Handles video processing tasks.
- **Responsibilities:**
  - Downloads videos.
  - Extracts information from videos.
- **Dependencies:** None

## Data Flow

1.  The `scraper.mjs` module fetches recipe data from various sources.
2.  The `pipeline.mjs` module processes and transforms the scraped data.
3.  The `db.mjs` module stores the processed data in the database.
4.  The `server.mjs` module exposes the data through an API.
5.  The `worker.mjs` module executes background tasks, such as long-running scraping jobs, using `scraper.mjs`, `pipeline.mjs`, and `db.mjs`.
6.  The `gcs.mjs` module interacts with Google Cloud Storage for storing data.
7.  The `gemini.mjs` module integrates with the Gemini API for enhanced data processing.
8.  The `migrate.mjs` module manages database schema changes.
9.  The `video.mjs` module handles video processing tasks.

## Future Considerations

- Implement caching to improve API performance.
- Add support for more data sources.
- Improve the data processing pipeline to handle more complex recipes.
- Implement a user interface for browsing
