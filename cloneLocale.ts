import { config } from "dotenv";
import fetch from "node-fetch";
import "dotenv/config";
import {
  createClient,
  AnyRegularField,
  GroupField,
  isFilled,
  RTNode,
  FilledLinkToMediaField,
} from "@prismicio/client";
import type { PrismicDocument, SliceZone } from "@prismicio/client";
const util = require('util')
import readline from 'readline';

const batchNumber = 1000

config();

const newLocale = process.argv[2] ?? process.env.NEW_LOCALE;
const templateRepository = process.env.TEMPLATE_DOMAIN;
const apiKey = process.env.MIGRATION_API_BETA_KEY;
const email = process.env.EMAIL;
const password = process.env.PASSWORD;
// Construct the Prismic Write request URLs
const migrationUrl = `https://migration.prismic.io/documents`;

async function init() {
  if (
    !templateRepository ||
    !newLocale ||
    !apiKey ||
    !email ||
    !password
  )
    throw new Error("Undefined configuration, please configure your .env file");
  try {
    log(
      `Initializing locale ${newLocale} based on the master locale of ${templateRepository}`
    );

    // Fetch the published documents from the template repository
    const client = createClient(templateRepository, { fetch });

    log(
      "Retrieving existing documents from the template for the master language"
    );
    const docs = await client.dangerouslyGetAll();

    log(`Retrieved ${docs.length} documents`);
    // if (docs.length > 1000) {
    //   log(
    //     "Uploading more than 1000 documents would fail because of the Migration Release current limit"
    //   );
    //   process.exit(1);
    // }
    // console.log(docs)

    // Get Auth token
    log("Generating a user token to use Prismic's APIs");
    const token = await getAuthToken();

    // Insert new Locale Ids in docs
    let docsWithNewLocale: (PrismicDocument & { title: string })[] = []
    //console.log(util.inspect(docs.slice(batch * 100, (batch + 1) * 100), { showHidden: false, depth: null, colors: true }))
    docsWithNewLocale = changeLocaleInDocs(docs);
    //console.log(util.inspect(docsWithNewLocale, { showHidden: false, depth: null, colors: true }))

    // Push docs with new Locale and build docComparisonTable
    log("Creating the documents with new locale");
    const docComparisonTable = await pushUpdatedDocs(
      docsWithNewLocale,
      token
    );
    console.log(docComparisonTable);

    // Insert new Links Ids in docs
    const docsWithNewLinks = mutateDocsWithLinks(
      docsWithNewLocale,
      docComparisonTable
    );
    console.log(docsWithNewLinks)

    // Push docs with new Link Ids
    log("Updating documents with links resolved");
    await pushUpdatedDocsWithLinks(docsWithNewLinks, token);
  } catch (err) {
    console.error("An error occurred:", err);
  }
}

init();

// Simple logger function
function log(message: string, nesting: number = 0): void {
  if (nesting === 0) console.log("[Init Content]: ", message);
  else {
    let padding = "";
    for (let i = 0; i < nesting; i++) {
      padding = padding + "\t";
    }
    console.log(padding, `- ${message}`);
  }
}

// Get an auth token
const getAuthToken = async () => {
  const authResponse = await fetch("https://auth.prismic.io/login", {
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "prismic-clone-script",
    },
    method: "POST",
    body: JSON.stringify({
      email,
      password,
    }),
  });

  const token = await authResponse.text();
  return token;
};

const delay = (ms: number | undefined) =>
  new Promise((resolve) => setTimeout(resolve, ms));

//Replace assetIDs in all docs
const changeLocaleInDocs = (
  docs: PrismicDocument[]
) => {
  const mutatedDocs: (PrismicDocument & { title: string, alternate_language_id?: string })[] = [];

  docs.forEach((document) => {
    const mutatedDoc: PrismicDocument & { title: string, alternate_language_id?: string } = {
      ...document,
      title: "Title",
    };

    mutatedDoc.alternate_language_id = document.id

    mutatedDoc.title = document.uid ?? document.type;

    mutatedDoc.lang = newLocale

    if (document && document.data) {
      // Extract from direct data properties
      mutatedDoc.data = editIntegrationFields(document.data);

      // Extract from slices if available
      if ("slices" in document.data && document.data.slices) {
        for (let i = 0; i < document.data.slices.length; i++) {
          // Extract from primary object
          if (document.data.slices[i].primary) {
            mutatedDoc.data.slices[i].primary = editIntegrationFields(
              document.data.slices[i].primary
            );
          }
          // Extract from each item in items array
          if (
            document.data.slices[i].items &&
            document.data.slices[i].items.length > 0
          ) {
            for (let j = 0; j < document.data.slices[i].items.length; j++) {
              mutatedDoc.data.slices[i].items[j] = editIntegrationFields(
                document.data.slices[i].items[j]
              );
            }
          }
        }
      }

      // Extract from slices if available
      if ("body" in document.data && document.data.body) {
        for (let i = 0; i < document.data.body.length; i++) {
          // Extract from primary object
          if (document.data.body[i].primary) {
            mutatedDoc.data.body[i].primary = editIntegrationFields(
              document.data.body[i].primary
            );
          }
          // Extract from each item in items array
          if (
            document.data.body[i].items &&
            document.data.body[i].items.length > 0
          ) {
            for (let j = 0; j < document.data.body[i].items.length; j++) {
              mutatedDoc.data.body[i].items[j] = editIntegrationFields(
                document.data.body[i].items[j]
              );
            }
          }
        }
      }
    }
    mutatedDocs.push(mutatedDoc);
  });
  return mutatedDocs;
};

//Replace old AssetId with new AssetId in image field
function editIntegrationFields(
  record: Record<string, AnyRegularField | GroupField | SliceZone>
) {
  for (const fieldName in record) {
    const field = record[fieldName];
    //Check if field is an IF
    if (
      field &&
      typeof field === "object" &&
      "urn" in field
    ) {
      field.id = field.urn;
      record[fieldName] = {};
    }
    // //Check if field a RichText or a Group containing an image
    if (field && Array.isArray(field)) {
      for (let i = 0; i < field.length; i++) {
        const item = field[i]
        for (const itemField in field[i]) {
          // Check if field is a Group containing an integration fields
          if (
            item[itemField as keyof typeof item] &&
            typeof item[itemField as keyof typeof item] === "object" &&
            "urn" in item[itemField as keyof typeof item]
          ) {
            field[i][itemField as keyof typeof item] = {} as never
          }
        }
      }
      //store changes
      record[fieldName] = field;
    }
  }
  return record;
}

// Push updated docs to target repository
const pushUpdatedDocs = async (
  docsWithNewAssetIds: (PrismicDocument & { title: string })[],
  token: string
) => {
  const docComparisonTable = docsWithNewAssetIds.map((doc) => ({
    olDid: doc.id,
    newId: "",
  }));

  for (let batch = 0; batch < docsWithNewAssetIds.length / batchNumber; batch++) {
    console.log(docsWithNewAssetIds.length / batchNumber)
    console.log(batch)
    for (let i = 0; i < batchNumber; i++) {
      const doc = docsWithNewAssetIds[batch * batchNumber + i];

      // Send the update
      try {
        const response = await fetch(migrationUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            "x-api-key": apiKey!,
            "Content-Type": "application/json",
            repository: templateRepository!,
            "User-Agent": "prismic-clone-script",
          },
          method: "POST",
          body: JSON.stringify(doc),
        });
        if (response.ok) {
          log(
            "New document imported of type : " +
            doc.type +
            " and uid: " +
            doc.uid +
            " id: " + batch * batchNumber + i,
            1
          );
          const newDoc = (await response.json()) as {
            id: string;
            type: string;
            lang: string;
            title: string;
          };
          docComparisonTable[i].newId = newDoc.id;
          if (newDoc.id === '') {
            console.error("request ok, but no ID", doc.id, doc.type, newDoc)
          }
        } else {
          throw Error(
            "Request failed for doc of type : " +
            doc.type +
            " and uid: " +
            doc.uid +
            " Error details : " +
            (await response.text())
          );
        }
        await delay(2000);
      } catch (err) {
        console.error("Error while uploading new document: ", err);
        throw Error("Error while uploading new documents");
      }
    }
    const shouldContinue = await askToContinue();
    if (shouldContinue) {
      console.log('Continuing execution...');
      // Place the code to continue execution here
    } else {
      console.log('Stopping execution...');
      process.exit(0);
    }
  }
  return docComparisonTable;
};

//Replace assetIDs in all docs (need to add support for RichText links)
const mutateDocsWithLinks = (
  docs: (PrismicDocument & { title: string })[],
  docComparisonTable: {
    olDid: string;
    newId: string;
  }[]
) => {
  const mutatedDocs: (PrismicDocument & { title: string })[] = [];

  docs.forEach((document) => {
    const mutatedDoc: PrismicDocument & { title: string } = { ...document };
    if (document && document.data) {
      // Set New id
      // richtext example https://github.com/prismicio-solution-engineering/sm-migration-scripts/blob/master/migrate-links.mjs
      mutatedDoc.id = docComparisonTable.find(
        (doc) => doc.olDid === document.id
      )!.newId;

      // Extract from direct data properties
      mutatedDoc.data = editIdFromLink(document.data, docComparisonTable);

      // Extract from slices if available
      if (document.data.slices) {
        for (let i = 0; i < document.data.slices.length; i++) {
          // Extract from primary object
          if (document.data.slices[i].primary) {
            mutatedDoc.data.slices[i].primary = editIdFromLink(
              document.data.slices[i].primary,
              docComparisonTable
            );
          }
          // Extract from each item in items array
          if (
            document.data.slices[i].items &&
            document.data.slices[i].items.length > 0
          ) {
            for (let j = 0; j < document.data.slices[i].items.length; j++) {
              mutatedDoc.data.slices[i].items[j] = editIdFromLink(
                document.data.slices[i].items[j],
                docComparisonTable
              );
            }
          }
        }
      }

      // Extract from body if available
      if (document.data.body) {
        for (let i = 0; i < document.data.body.length; i++) {
          // Extract from primary object
          if (document.data.body[i].primary) {
            mutatedDoc.data.body[i].primary = editIdFromLink(
              document.data.body[i].primary,
              docComparisonTable
            );
          }
          // Extract from each item in items array
          if (
            document.data.body[i].items &&
            document.data.body[i].items.length > 0
          ) {
            for (let j = 0; j < document.data.body[i].items.length; j++) {
              mutatedDoc.data.body[i].items[j] = editIdFromLink(
                document.data.body[i].items[j],
                docComparisonTable
              );
            }
          }
        }
      }
    }
    mutatedDocs.push(mutatedDoc);
  });
  return mutatedDocs;
};

//Replace old linkId with new linkId in link field
function editIdFromLink(
  record: Record<string, AnyRegularField | GroupField | SliceZone>,
  docComparisonTable: {
    olDid: string;
    newId: string;
  }[]
) {
  const findLinkId = (oldId: string): string => {
    const entry = docComparisonTable.find((doc) => doc.olDid === oldId);
    if (entry === undefined)
      throw new Error(`The new ID for the link ${oldId} couldn't be found`);
    return entry.newId;
  };

  for (const fieldName in record) {
    const field = record[fieldName];
    //Check if field is a Link
    if (
      field &&
      typeof field === "object" &&
      "id" in field &&
      typeof field.id === "string" &&
      "isBroken" in field &&
      field.isBroken === false
    ) {
      field.id = findLinkId(field.id);
      record[fieldName] = field;
    }
    //Check if field a RichText or a Group containing a Link
    if (field && Array.isArray(field)) {
      for (let i = 0; i < field.length; i++) {
        const fieldItem = field[i];
        // Check if field is a RichText containing a link
        if (
          "type" in fieldItem &&
          "spans" in fieldItem &&
          Array.isArray(fieldItem.spans) &&
          fieldItem.spans.length > 0
        ) {
          for (let j = 0; j < fieldItem.spans.length; j++) {
            const fieldItemSpan = fieldItem["spans"][j];
            if (
              fieldItemSpan.type === "hyperlink" &&
              "data" in fieldItemSpan &&
              fieldItemSpan.data.link_type === "Document" &&
              fieldItemSpan.data.isBroken === false
            ) {
              const fieldItemSpanlinkId = fieldItemSpan.data.id;
              fieldItemSpan.data.id = findLinkId(fieldItemSpanlinkId);
            }
            fieldItem["spans"][j] = fieldItemSpan;
          }
        }
        // Check if field is a Group containing an image
        if (!("slice_type" in fieldItem) && !("type" in fieldItem)) {
          for (const subFieldName in fieldItem) {
            const subField = fieldItem[subFieldName];
            // Check if field is a Group containing directly a link
            if (
              subField &&
              typeof subField === "object" &&
              "id" in subField &&
              typeof subField.id === "string" &&
              "isBroken" in subField &&
              subField.isBroken === false
            ) {
              subField.id = findLinkId(subField.id);
              fieldItem[subFieldName] = subField;
            }
            // Check if field is a Group containing a RichText containing a link
            if (Array.isArray(subField)) {
              for (let j = 0; j < subField.length; j++) {
                const richTextItem = subField[j] as RTNode;
                // Check if field is a RichText containing a link
                if (
                  "type" in richTextItem &&
                  "spans" in richTextItem &&
                  Array.isArray(richTextItem.spans) &&
                  richTextItem.spans.length > 0
                ) {
                  for (let k = 0; k < richTextItem.spans.length; k++) {
                    const fieldItemSpan = richTextItem["spans"][k];
                    if (
                      fieldItemSpan.type === "hyperlink" &&
                      "data" in fieldItemSpan &&
                      fieldItemSpan.data.link_type === "Document" &&
                      fieldItemSpan.data.isBroken === false
                    ) {
                      const fieldItemSpanlinkId = fieldItemSpan.data.id;
                      fieldItemSpan.data.id = findLinkId(fieldItemSpanlinkId);
                    }
                    richTextItem["spans"][k] = fieldItemSpan;
                  }
                }
                subField[j] = richTextItem;
              }
              fieldItem[subFieldName] = subField;
            }
          }
        }
        // store changes
        field[i] = fieldItem;
      }
      //store changes
      record[fieldName] = field;
    }
  }
  return record;
}

// Push updated docs to target repository
const pushUpdatedDocsWithLinks = async (
  docsWithNewLinks: (PrismicDocument & { title: string })[],
  token: string
) => {
  for (let i = 0; i < docsWithNewLinks.length; i++) {
    const doc = docsWithNewLinks[i];
    // Send the update
    const response = await fetch(migrationUrl + "/" + doc.id, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-key": apiKey!,
        "Content-Type": "application/json",
        repository: templateRepository!,
        "User-Agent": "prismic-clone-script",
      },
      method: "PUT",
      body: JSON.stringify(doc),
    });

    await delay(1000);
  }
};


// Function to prompt the user for input
function askToContinue() {
  // Create an interface for reading lines from the console
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question('PUBLISH your migration release then \nType "c" to continue, anthing else will stop execution: ', (answer) => {
      if (answer.toLowerCase() === 'c') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}