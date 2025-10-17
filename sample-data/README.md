# Sample Data (5% downsample)

This folder contains reduced monthly CSVs for faster local development.

How to generate from the full dataset in ../data:

1. Ensure Node.js is installed.
2. From the project root, run:

   node scripts/make-sample-data.js --rate 0.05

Optional:

- Use a different rate (e.g., 2%):

   node scripts/make-sample-data.js --rate 0.02

- Make sampling reproducible with a seed:

   node scripts/make-sample-data.js --rate 0.05 --seed 42

The script will create the following files in this directory (one per month):

- Bike share ridership 2023-01.csv
- Bike share ridership 2023-02.csv
- ...
- Bike share ridership 2023-12.csv

The application is configured to load CSVs from this `sample-data` directory by default. If these files are missing, the app will still attempt to run, but you should generate them to see real data.
