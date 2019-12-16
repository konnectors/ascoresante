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
const formatDate = require('date-fns/format')

const baseUrl = 'https://www.ascoregestion.com/assure'
const decomptesUrl = `${baseUrl}/remboursements`

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  log('info', 'Fetching the list of reimbursements')
  const reimbursements = parseReimbursements(await request(decomptesUrl))
  log('info', 'Fetching the reimbursements details')
  const documents = await getReimbursementDetails(reimbursements)
  // Doc: https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    // This is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['axiome'],
    contentType: 'application/pdf'
  })
}

// Authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
function authenticate(login, password) {
  return signin({
    url: `${baseUrl}/connexion`,
    formSelector: 'form#form_auth',
    formData: {
      login: login,
      password: password
    },
    // The validate function will check if at least one logout link exists
    validate: (statusCode, $) => {
      if ($(`a[href='${baseUrl}/logout']`).length >= 1) {
        return true
      } else {
        return false
      }
    }
  })
}

// This function retrieves all the reimbursements for the user,
// which are all present in the same HTML page.
function parseReimbursements(page) {
  const reimbursements = scrape(
    page,
    {
      // Watch out, there is a hidden column at the beginning!
      date: {
        sel: 'td:nth-child(2)',
        parse: normalizeDate
      },
      number: {
        sel: 'td:nth-child(3)'
      },
      amount: {
        sel: 'td:nth-child(5)',
        parse: normalizePrice
      },
      detailsUrl: {
        sel: 'td:nth-child(8)>a',
        attr: 'href'
      }
    },
    'table#remboursements>tbody>tr'
  )

  log('debug', 'Reimbursements list')
  log('debug', reimbursements)
  return reimbursements
}

// This function parses a reimbursement detail page
// and extracts all the necessary details.
function parseDetails(page) {
  // First retrieve the details of the medical treatment
  let detailsData = scrape(
    page,
    {
      treatmentDate: {
        sel: 'td:nth-child(1)',
        parse: normalizeDate
      },
      beneficiary: {
        sel: 'td:nth-child(3)'
      },
      treatmentType: {
        sel: 'td:nth-child(4)'
      },
      originalAmount: {
        sel: 'td:nth-child(5)',
        parse: normalizePrice
      },
      ascoreAmount: {
        sel: 'td:nth-child(6)',
        parse: normalizePrice
      },
      otherAmount: {
        sel: 'td:nth-child(7)',
        parse: normalizePrice
      },
      ssAmount: {
        sel: 'td:nth-child(8)',
        parse: normalizePrice
      }
    },
    'table.table>tbody>tr:not(:last-child)'
  )

  // Then retrieve the URL of the PDF file
  const pdf = scrape(page('div.row>div.col-sm-4'), {
    fileUrl: {
      sel: 'a',
      attr: 'href'
    }
  })
  if (pdf.fileUrl) detailsData.fileUrl = pdf.fileUrl

  log('debug', 'Reimbursements details:')
  log('debug', detailsData)
  return detailsData
}

// This function returns a list of Cozy documents with all details,
// ready to store
async function getReimbursementDetails(reimbursements) {
  const documents = []

  for (let reimbursement of reimbursements) {
    // First get details for each reimbursement
    const detailsData = parseDetails(await request(reimbursement.detailsUrl))
    // Then check if the document really exists before adding it to the list
    if (await checkUrl(detailsData.fileUrl)) {
      // Create a bill for each elementary medical act
      for (let details of detailsData) {
        // Then create the new document with all data,
        // cf. bill doctype: https://github.com/cozy/cozy-doctypes/blob/master/docs/io.cozy.bills.md
        const doc = {
          title: details.treatmentType,
          amount: details.ascoreAmount,
          originalAmount: details.originalAmount,
          groupAmount: reimbursement.amount,
          socialSecurityRefund: details.ssAmount,
          isRefund: true,
          fileurl: detailsData.fileUrl,
          filename: normalizeFileName(reimbursement.date, reimbursement.number),
          date: reimbursement.date,
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

  log('debug', 'Documents to save: ')
  log('debug', documents)
  return documents
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
function normalizeFileName(date, fileNum) {
  return formatDate(date, 'YYYYMMDD') + '_' + fileNum + '.pdf'
}

async function checkUrl(url) {
  try {
    await request(url)
    return true
  } catch (err) {
    log('error', err.message)
    return false
  }
}
