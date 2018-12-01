const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')
const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is set to false by default
  debug: false,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // This allows request-promise to keep cookies between requests
  jar: true
})

const baseUrl = 'https://ascoregestion.com'
const decomptesUrl = `${baseUrl}/adh-s-mes-decomptes`
const decomptesFiltreUrl = `${baseUrl}/adh-s-mes-decomptes-filtre`
const documentsUrl = `${baseUrl}/adherent/decompte/pdf`
const decompteDetailUrl = `${baseUrl}/adh-s-mes-decomptes-details`

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Fetching the list of years')
  const $ = await request(decomptesUrl)
  log('info', 'Parsing list of years')
  const documents = []
  const years = await parseYears($)
  for (let year of years) {
    log('info', 'Fetching the list of documents for year ' + year.value)

    const page = await request(decomptesFiltreUrl, {
      method: 'POST',
      form: {
        annee: year.value,
        mois: -1
      },
      json: true
    })

    log('info', 'Parsing list of documents for year ' + year.value)
    // The POST response contains an array of JSON objects
    for (let reimbursement of page._root.children) {
      // First get details for each reimbursement, i.e. each JSON object
      const detailsPage = await request(
        `${decompteDetailUrl}/${reimbursement.sin_num}`
      )
      const detailsData = scrape(
        detailsPage,
        {
          originalAmount: {
            sel: 'td:nth-child(3)',
            parse: normalizePrice
          },
          ssAmount: {
            sel: 'td:nth-child(5)',
            parse: normalizePrice
          },
          ascoreAmount: {
            sel: 'td:nth-child(7)',
            parse: normalizePrice
          }
        },
        '.tabloDecomptesDetails>tbody>tr:not(:nth-child(1)):not(:nth-child(2))'
      )

      // Check if document really exists before adding it to the list
      const fileUrl = documentsUrl + '/' + reimbursement.sin_num
      const fileExists = await checkUrl(fileUrl)
      if (fileExists) {
        // Create a bill for each elementary medical act
        for (let amounts of detailsData) {
          // Then create the new document with all data,
          // cf. bill doctype: https://github.com/cozy/cozy-doctypes/blob/master/docs/io.cozy.bills.md
          const doc = {
            title: reimbursement.sin_typeremboursement,
            amount: amounts.ascoreAmount,
            originalAmount: amounts.originalAmount,
            groupAmount: normalizePrice(reimbursement.remboursement),
            socialSecurityRefund: amounts.ssAmount,
            isRefund: true,
            fileurl: fileUrl,
            filename: normalizeFileName(
              reimbursement.sin_num,
              reimbursement.sin_date_remboursement
            ),
            date: normalizeDate(reimbursement.sin_date_remboursement),
            currency: '€',
            vendor: 'ascoreSante',
            type: 'health_costs',
            metadata: {
              // It can be interesting that we add the date of import. This is not mandatory but may be
              // useful for debugging or data migration
              importDate: new Date(),
              // Document version, useful for migration after change of document structure
              version: 1
            }
          }
          documents.push(doc)
        }
      }
    }
  }

  // Here we use the saveBills function even if what we fetch are not bills,
  // but this is the most common case in connectors
  // Doc: https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    // This is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['axiome']
  })
}

// Authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
function authenticate(identifiant_auth, mdp_auth) {
  return signin({
    url: `${baseUrl}/identification?type=cHJldmFzc3Vy`,
    formSelector: 'form#form_auth',
    formData: { identifiant_auth, mdp_auth },
    // The validate function will check if a logout link exists
    validate: (statusCode, $) => {
      if ($(`a[href='/logout']`).length === 1) {
        return true
      } else {
        return false
      }
    }
  })
}

// This function retrieves all the years available for the user by parsing
// an HTML page wrapped by a cheerio instance and returns an array of years.
function parseYears($) {
  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const years = scrape(
    $,
    {
      value: {
        attr: 'value'
      }
    },
    '#annee>option'
  )

  return years
}

// Convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.replace(',', '.').trim())
}

// Convert a date string to a date
function normalizeDate(date) {
  // String format: dd/mm/yyyy
  return new Date(
    date.slice(6, 10) + '-' + date.slice(3, 5) + '-' + date.slice(0, 2) + 'Z'
  )
}

// Create the file name, as YYYYMMDD_fileNum.pdf
function normalizeFileName(fileNum, date) {
  // String format: dd/mm/yyyy
  return (
    date.slice(6, 10) +
    date.slice(3, 5) +
    date.slice(0, 2) +
    '_' +
    fileNum +
    '.pdf'
  )
}

async function checkUrl(url) {
  const pdf = await request(url)
  const notFound = scrape(pdf('.col-md-12'), {
    text: {
      sel: 'p'
    }
  })
  if (notFound.text === 'Fichier non trouvé.') {
    log('warn', 'File not found at URL ' + url)
    return false
  }

  return true
}
