const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data.json');

// Helper to read data
const readData = () => {
    if (!fs.existsSync(DATA_FILE)) return [];
    try {
        const content = fs.readFileSync(DATA_FILE, 'utf8');
        return content ? JSON.parse(content) : [];
    } catch (e) {
        console.error('Error reading data file:', e);
        return [];
    }
};

// Helper to write data
const writeData = (data) => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

async function loginToGoogle(page) {
    console.log('Logging in to Google...');
    try {
        await page.goto('https://accounts.google.com/ServiceLogin', { waitUntil: 'networkidle2' });

        // Enter Email
        await page.waitForSelector('input[type="email"]');
        await page.type('input[type="email"]', 's.mortabit@rate-match.com');
        await page.click('#identifierNext');

        // Wait for password field
        await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
        await new Promise(r => setTimeout(r, 1000)); // Brief pause for animation

        // Enter Password
        await page.type('input[type="password"]', 's.mortabit@2025');
        await page.click('#passwordNext');

        // Wait for successful login
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        console.log('Login successful.');
    } catch (err) {
        console.error('Login failed or already logged in:', err.message);
    }
}

async function scrapeHotels(url) {
    console.log(`Starting scrape for ${url}`);
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
        await loginToGoogle(page);

        if (url.includes('google.com/maps')) {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

            // Infinite scroll logic for Google Maps sidebar
            console.log('Starting infinite scroll...');
            let scrollCycles = 0;
            const maxCycles = 50;
            let previousCount = 0;

            while (scrollCycles < maxCycles) {
                const listings = await page.$$('div[role="article"]');
                console.log(`Cycle ${scrollCycles + 1}/${maxCycles}: Found ${listings.length} listings so far.`);

                if (listings.length > 0) {
                    await listings[listings.length - 1].scrollIntoView();
                }

                await new Promise(r => setTimeout(r, 3000));

                const currentCount = (await page.$$('div[role="article"]')).length;
                if (currentCount === previousCount) {
                    console.log('No new results found after scrolling, stopping...');
                    break;
                }
                previousCount = currentCount;
                scrollCycles++;
            }
            console.log(`Scroll finished after ${scrollCycles} cycles.`);

            const hotelElements = await page.$$('div[role="article"]');
            const hotelNames = [];
            for (const el of hotelElements) {
                const name = await el.evaluate(node => node.getAttribute('aria-label'));
                if (name) hotelNames.push(name);
            }

            console.log(`Found ${hotelNames.length} listing names. Starting detail extraction...`);

            const detailedHotels = [];
            for (let i = 0; i < hotelNames.length; i++) {
                const targetName = hotelNames[i];
                console.log(`Extracting details for: ${targetName} (${i + 1}/${hotelNames.length})`);

                try {
                    // Re-fetch elements because clicking might detach nodes
                    const freshElements = await page.$$('div[role="article"]');
                    let targetEl = null;
                    for (const el of freshElements) {
                        const name = await el.evaluate(node => node.getAttribute('aria-label'));
                        if (name === targetName) {
                            targetEl = el;
                            break;
                        }
                    }

                    if (targetEl) {
                        await targetEl.click();
                        await new Promise(r => setTimeout(r, 2000));

                        const details = await page.evaluate(() => {
                            const getVal = (selector, attr = 'innerText') => {
                                const el = document.querySelector(selector);
                                return el ? el[attr] : 'N/A';
                            };

                            const phoneNode = document.querySelector('button[aria-label^="Numéro de téléphone"]');
                            const websiteNode = document.querySelector('a[aria-label^="Site Web"], a[aria-label^="Accéder au site Web"]');
                            const addressNode = document.querySelector('button[aria-label^="Adresse"]');

                            return {
                                address: addressNode ? addressNode.innerText : 'N/A',
                                phone: phoneNode ? phoneNode.innerText : 'N/A',
                                website: websiteNode ? websiteNode.href : 'N/A',
                                rating: getVal('span[aria-label*="étoiles"]')
                            };
                        });

                        detailedHotels.push({
                            name: targetName,
                            city: 'Marrakech',
                            ...details,
                            type: targetName.toLowerCase().includes('riad') ? 'Riad' : 'Hotel',
                            source: 'Google Maps'
                        });
                    }
                } catch (innerErr) {
                    console.error(`Error extracting ${targetName}:`, innerErr.message);
                }
            }

            // Save and merge
            const existingData = readData();
            const mergedData = [...existingData];
            detailedHotels.forEach(newHotel => {
                const idx = mergedData.findIndex(h => h.name === newHotel.name);
                if (idx > -1) {
                    mergedData[idx] = { ...mergedData[idx], ...newHotel };
                } else {
                    mergedData.push(newHotel);
                }
            });

            writeData(mergedData);
            console.log(`Successfully scraped details for ${detailedHotels.length} hotels from Google Maps`);
            console.log(`Updated data.json with ${mergedData.length} hotels (included updates)`);
        }
    } catch (err) {
        console.error('Scraping error:', err);
    } finally {
        await browser.close();
    }
}

app.get('/api/hotels', (req, res) => {
    res.json(readData());
});

app.post('/api/scrape', (req, res) => {
    const { url } = req.body;
    scrapeHotels(url);
    res.json({ message: 'Scraping started' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { scrapeHotels };
