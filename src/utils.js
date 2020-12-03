const Apify = require('apify');

const { log } = Apify.utils;

const { BASE_URL } = require('./constants');

function validateInput(input) {
    if (!input) throw new Error('INPUT is missing.');
    if (!input.searchTerms) input.searchTerms = [];

    // validate function
    const validate = (inputKey, type = 'string') => {
        const value = input[inputKey];

        if (type === 'array') {
            if (!Array.isArray(value)) {
                throw new Error(`Value of ${inputKey} should be array`);
            }
        } else if (value) {
            if (typeof value !== type) {
                throw new Error(`Value of ${inputKey} should be ${type}`);
            }
        }
    };

    // check required field
    if (input.searchTerms.length <= 0 && !input.spreadsheetId) {
        throw new Error('At least "searchTerms" or "spreadsheetId" must be provided as INPUT.');
    }

    const sheetProvided = !!input.spreadsheetId;

    // check correct types
    validate('searchTerms', 'array');
    if (sheetProvided) {
        validate('spreadsheetId', 'string');
        if (input.spreadsheetId.length !== 44) throw new Error('The spreadsheet ID looks wrong - spreadsheetId field needs to be a string with 44 characters!');
    }
    validate('maxItems', 'number');
    validate('extendOutputFunction', 'string');
    validate('proxyConfiguration', 'object');
}

async function checkAndCreateUrlSource(searchTerms, spreadsheetId, isPublic, timeRange, category, customTimeRange, geo) {
    const sources = [];
    let output;

    const timeRangeToUse = customTimeRange || timeRange;

    if (searchTerms) {
        for (const searchTerm of searchTerms) {
            let url = `${BASE_URL}?q=${encodeURIComponent(searchTerm)}`;

            if (timeRangeToUse) {
                url += `&date=${encodeURIComponent(timeRangeToUse)}`;
            }

            if (category) {
                url += `&cat=${category}`;
            }

            if (geo) {
                // const geoObj = GEOLOCATIONS.filter(o => o.id === geo)[0];
                // if (geoObj) {
                //     url = url + `&geo=${geoObj.id}`;
                // }
                url += `&geo=${geo}`;
            }

            sources.push({ url, userData: { label: 'START' } });
        }
    }

    if (spreadsheetId) {
        log.info('Importing spreadsheet...');
        const run = await Apify.call('lukaskrivka/google-sheets', {
            mode: 'read',
            spreadsheetId,
            publicSpreadsheet: isPublic,
            deduplicateByEquality: false,
            createBackup: false,
            // tokensStore: "google-oauth-tokens" // default
        });

        output = run.output.body;

        // Validation of the output
        const isBadFormat = output.some((item) => Object.keys(item).length !== 1);
        if (isBadFormat) throw new Error('Spreadsheet must have only one column. Check the actor documentation for more info.');

        log.info('Spreadsheet successfully imported.');

        for (const item of output) {
            const searchTerm = Object.values(item)[0];
            let url = `${BASE_URL}?q=${encodeURIComponent(searchTerm)}`;

            if (timeRangeToUse) {
                url += `&date=${encodeURIComponent(timeRangeToUse)}`;
            }

            if (category) {
                url += `&cat=${category}`;
            }

            if (geo) {
                url += `&geo=${geo}`;
            }

            sources.push({ url, userData: { label: 'START' } });
        }
    }

    // grab the name of the custom column title
    const sheetTitle = spreadsheetId ? Object.keys(output[0])[0] : 'Term / Date';

    log.info(`Created ${sources.length} Start URLs`);

    return { sources, sheetTitle };
}

function maxItemsCheck(maxItems, itemCount) {
    if (itemCount >= maxItems) {
        log.info('Actor reached the max items limit. Crawler is going to halt...');
        log.info('Crawler Finished.');
        process.exit();
    }
}

function checkAndEval(extendOutputFunction) {
    if (!extendOutputFunction) {
        return;
    }

    let evaledFunc;

    try {
        evaledFunc = eval(extendOutputFunction);
    } catch (e) {
        throw new Error(`extendOutputFunction is not a valid JavaScript! Error: ${e}`);
    }

    if (typeof evaledFunc !== 'function') {
        throw new Error('extendOutputFunction is not a function! Please fix it or use just default output!');
    }
}

/**
 * No-op when no extendOutputFunction
 */
async function applyFunction(page, extendOutputFunction) {
    if (!extendOutputFunction) {
        return {};
    }

    const isObject = (val) => typeof val === 'object' && val !== null && !Array.isArray(val);

    let userResult = {};
    try {
        userResult = await page.evaluate(async (eof) => {
            return eval(eof)(window.jQuery);
        }, extendOutputFunction);
    } catch (err) {
        log.error(`extendOutputFunction crashed! Pushing default output. Please fix your function if you want to update the output.\n\t${err}`);
    }

    if (!isObject(userResult)) {
        log.exception(new Error('extendOutputFunction must return an object!'));
        process.exit(1);
    }

    return userResult;
}

/**
 * The actor provides a way to use custom time ranges, so we need to
 * brute force the returned dates. It assumes UTC, might be wrong with
 * other geo parameters
 *
 * @param {string} key
 */
function parseKeyAsIsoDate(key) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentDay = now.getDay();
    const currentMonth = now.getMonth();

    key = key.replace(/\s(AM|PM)/gi, ' $1');

    try {
        // toISOString() throws with 'Invalid time value'. Valid dates with year, Nov 3, 2020
        const newDate = new Date(key);
        if (newDate.getFullYear() < currentYear - 5) {
            // means date is falling back to 2001
            return new Date(`${key}, ${currentYear}`).toISOString();
        }
        return newDate.toISOString();
    } catch (e) {
        try {
            // Nov 13 at 11:00 PM -> Nov 13, 2020, 11:00 PM
            return new Date(key.replace(' at ', `, ${currentYear}, `)).toISOString();
        } catch (e) {
            // 11:00PM
            const dummyDate = new Date(`${currentDay}/${currentMonth + 1}, ${currentYear}, ${key}`);
            now.setHours(dummyDate.getHours(), dummyDate.getMinutes(), 0, 0);
            return now.toISOString();
        }
    }
}

module.exports = {
    validateInput,
    parseKeyAsIsoDate,
    checkAndCreateUrlSource,
    maxItemsCheck,
    checkAndEval,
    applyFunction,
};
