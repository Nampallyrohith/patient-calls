const { google } = require("googleapis");
const path = require("path");

// Load the service account key JSON file
const KEYFILEPATH = path.join(__dirname, "serviceAccountKey.json");

// Define the required scopes
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

// Initialize Google Auth
const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILEPATH,
  scopes: SCOPES,
});

// Create instances for Sheets and Drive APIs
const sheets = google.sheets({ version: "v4", auth });
const drive = google.drive({ version: "v3", auth });

// Define folder names (these should match the folder names in Google Drive)
const folderNames = {
  2023: "2023",
  2024: "2024",
  "07": "07",
  "08": "08",
  "09": "09",
  15: "15",
  "02": "02",
  18: "18",
};

async function getFolderIds() {
  const folderIds = {};

  const folderResponse = await drive.files.list({
    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: "files(id, name, parents)",
  });

  const folders = folderResponse.data.files;
  if (folders.length) {
    folders.forEach((folder) => {
      for (const key in folderNames) {
        if (folder.name === folderNames[key]) {
          folderIds[key] = folder.id;
        }
      }
    });
  } else {
    console.error("No folders found.");
  }

  return folderIds;
}

async function ensureImportantFolder(dayFolderId) {
  try {
    const folderResponse = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${dayFolderId}' in parents and name = 'important'`,
      fields: "files(id, name)",
    });

    const folders = folderResponse.data.files;
    if (folders.length === 0) {
      // Create "important" folder
      const folderMetadata = {
        name: "important",
        mimeType: "application/vnd.google-apps.folder",
        parents: [dayFolderId],
      };

      const folder = await drive.files.create({
        resource: folderMetadata,
        fields: "id",
      });

      console.log(`Created "important" folder with ID: ${folder.data.id}`);
      return folder.data.id;
    } else {
      console.log("Important folder already exists.");
      return folders[0].id;
    }
  } catch (error) {
    console.error(`Error ensuring important folder: ${error.message}`);
  }
}

async function filterAndCopyPatientDetails() {
  try {
    const folderIds = await getFolderIds();
    if (Object.keys(folderIds).length === 0) {
      console.error("No folder IDs found.");
      return;
    }

    const authClient = await auth.getClient();
    const spreadsheetId = "1viQIc8FS2fZQJvAFqz8DWBEd04xuvNj-Nt0ufS1PEC0"; // Original Google Sheet ID
    const range = "Sheet1!A:K"; // Adjust range according to your sheet structure

    // Get all data from the original sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: range,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log("No data found.");
      return;
    }

    // Skip header row
    rows.shift();

    // Process each row in the spreadsheet
    for (const row of rows) {
      const [
        date,
        time,
        callerName,
        from_patient_mobile,
        to_clinic_mobile,
        patientId,
        reasonForCall,
        handledBy,
        callOutcome,
      ] = row;

      // Combine date and time into a Date object
      const dateTime = new Date(`${date}T${time}`);

      const year = dateTime.getFullYear().toString();
      const month = String(dateTime.getMonth() + 1).padStart(2, "0"); // Month is zero-based
      const day = String(dateTime.getDate()).padStart(2, "0");

      // Debugging output
      console.log(`Parsed Date: ${date}`);
      console.log(`Year: ${year}, Month: ${month}, Day: ${day}`);

      // Get the folder ID for the day
      const dayFolderId = folderIds[day];
      const monthFolderId = folderIds[month];

      if (!dayFolderId || !monthFolderId) {
        console.error(`Folder ID for ${year}/${month}/${day} not found.`);
        continue;
      }

      // Ensure the "important" folder exists and get its ID
      const importantFolderId = await ensureImportantFolder(dayFolderId);

      // Construct the filename
      const fileName = `${patientId}-${to_clinic_mobile}-${from_patient_mobile}-${dateTime.toISOString()}.txt`;

      // Create text content for the file
      const fileContent = `Date: ${date}\nTime: ${time}\nCaller Name: ${callerName}\nPatient Called from: ${from_patient_mobile}\nClinic_mobile:${to_clinic_mobile}\nPatient ID: ${patientId}\nReason for Call: ${reasonForCall}\nHandled By: ${handledBy}\nCall Outcome: ${callOutcome}\n`;

      // Upload the text file to the day folder
      await uploadFileToFolder(dayFolderId, fileContent, fileName);

      // Check if the file content contains the `from_patient_mobile` number
      if (fileContent.includes(from_patient_mobile)) {
        await moveFileToFolder(dayFolderId, importantFolderId, fileName);
      }
    }
  } catch (error) {
    console.error(`Error in filterAndCopyPatientDetails: ${error.message}`);
  }
}

async function uploadFileToFolder(folderId, fileContent, fileName) {
  try {
    console.log(`Uploading file to folder ID: ${folderId}`);

    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const media = {
      mimeType: "text/plain",
      body: fileContent,
    };

    await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id",
    });

    console.log(`File uploaded successfully: ${fileName}`);
  } catch (error) {
    console.error(`Error uploading file ${fileName}: ${error.message}`);
  }
}

async function moveFileToFolder(sourceFolderId, destinationFolderId, fileName) {
  try {
    // Find the file in the source folder
    const fileResponse = await drive.files.list({
      q: `mimeType = 'text/plain' and name = '${fileName}' and '${sourceFolderId}' in parents`,
      fields: "files(id)",
    });

    const files = fileResponse.data.files;
    if (files.length === 0) {
      console.error(
        `File ${fileName} not found in source folder ${sourceFolderId}.`
      );
      return;
    }

    const fileId = files[0].id;

    // Update the file's parents to move it
    await drive.files.update({
      fileId: fileId,
      addParents: destinationFolderId,
      removeParents: sourceFolderId,
      fields: "id, parents",
    });

    console.log(
      `File ${fileName} moved to important folder with ID: ${destinationFolderId}`
    );
  } catch (error) {
    console.error(`Error moving file ${fileName}: ${error.message}`);
  }
}

filterAndCopyPatientDetails().catch(console.error);
