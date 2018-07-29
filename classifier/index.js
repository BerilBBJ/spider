let svm = require("./node-svm/lib");
let commandLineArgs = require("command-line-args");
let csvjson = require("csvjson");
let fs = require("fs");
let path = require("path");
let db = require("./models");
let Op = db.Sequelize.Op;

// Read input - if we have any: this should be a manually labelled dataset
// mode supports either train, apply or insert
// train: train the classifier on the training data available from the db
// apply: apply the model to the not yet classified entries
// insert: only insert manuall labelled content, do nothing else
const commandLineOptions = commandLineArgs([
    {name: "labelled_dataset", alias: "d", type: String, defaultOption: true},
    {name: "legal_model", alias: "l", type: String},
    {name: "class_model", alias: "c", type: String},
    {name: "output_dir", alias: "o", type: String},
    {name: "mode", alias: "m", type: String},
    {name: "quantile", alias: "q", type: String},
    {name: "limit", alias: "k", type: String}
]);

let labelModelsByLabel;

// MODEL variable is instantiated here, in order to save it to disk
// in case of a crash. Every crash handler has access to the model
// and the storeModel function.
let classModel;
let legalModel;

/**
 * Check if model files are available or specified on startup and load the
 * corresponding models. The file names are classModel.json and legalModel.json.
 * If none available, initialize the models as null model.
 * The function does not return anything but makes the models available in the
 * respective global variables classModel and legalModel.
 */
function loadModels() {
    /**
     * Takes the provided path string and returns the loaded object
     * @param  {String} sourceString The path to the model file
     * @return {Object} The model read or empty model if not found any model
     */
    function loader(sourceString) {
        let rawPath = null;
        if (sourceString &&
            !path.isAbsolute(sourceString)) {
            rawPath = path.join(
                __dirname,
                sourceString
            );
            rawPath = path.normalize(rawPath);
        } else if (sourceString) {
            rawPath = path.normalize(sourceString);
        } else {
            rawPath = path.join(
                __dirname,
                "legalModel.json"
            );
        }

        try {
            let modelString = fs.readFileSync(
                rawPath,
                {encoding: "utf8"}
            );
            return JSON.parse(modelString);
        } catch (e) {
            console.log("No model found in directory " + rawPath);
            console.log("Using empty model");
            return {};
        }
    }

    legalModel = loader(commandLineOptions.legal_model);
    classModel = loader(commandLineOptions.class_model);
}

/**
 * Store the currently trained model into model.json file. This is necessary in
 * order to not loose the progress made so far. That way we can train further
 * from run to run
 */
function storeModels() {
    let destinationPath = commandLineOptions.output_dir;
    if (
        destinationPath &&
        !path.isAbsolute(destinationPath)
    ) {
        destinationPath = path.join(
            __dirname,
            destinationPath
        );
        destinationPath.normalize(destinationPath);
    } else if (destinationPath) {
        destinationPath.normalize(destinationPath);
    } else {
        destinationPath = __dirname;
    }
    let legalModelDestPath = path.join(
        destinationPath,
        "legalModel.json"
    );
    fs.writeFileSync(legalModelDestPath, JSON.stringify(legalModel), "utf-8");
    let classModelDestPath = path.join(
        destinationPath,
        "classModel.json"
    );
    fs.writeFileSync(classModelDestPath, JSON.stringify(classModel), "utf-8");
}

/**
 * Insert or update labels according to the labels.json config file.
 * This results in up to date label descriptions.
 * @return {Object} Return an object indexed by label, containing the model
 *                         for each label.
 */
async function upsertLabels() {
    let labelsPath = path.join(
        __dirname,
        "labels.json"
    );
    let labelString = fs.readFileSync(labelsPath);
    let labelsRawObject = JSON.parse(labelString);
    let labels = db.label.bulkUpsert(labelsRawObject);
    let result = {};
    for ( let i = 0; i < labels.length; i++ ) {
        result[labels[i].label] = labels[i];
    }
    return result;
}

/**
 * Add train data to the database. This must follow the provided example below:
 * cleanContentId;legal;label
 * 408751f4-4dab-46a3-a6e1-110b32e9e98b;legal;Mail
 * 32713375-1ae0-42ef-867a-eb855069ab30;legal;Hosting
 * Please check the already available classes in ./labels.json and see if you
 * find a good fit there. If not, please discuss the introduction of new classes
 * in a feedback.
 * The title in the file is important, this function expects the file to contain
 * such a title
 */
async function addTrainData() {
    let pathToLabelledData;
    let labelledData = [];
    if (commandLineOptions.labelled_dataset &&
        !path.isAbsolute(commandLineOptions.labelled_dataset)) {
        pathToLabelledData = path.join(
            __dirname,
            commandLineOptions.labelled_dataset
        );
        pathToLabelledData = path.normalize(pathToLabelledData);
    } else if (commandLineOptions.labelled_dataset) {
        pathToLabelledData = path.normalize(
            commandLineOptions.labelled_dataset
        );
    }
    if (!pathToLabelledData) {
        console.log("No labelled data provided.");
        return;
    }

    let csvData = fs.readFileSync(
        pathToLabelledData,
        {encoding: "utf8"}
    );

    let csvOptions = {
        delimiter: ";",
        quote: "\"",
    };

    labelledData = csvjson.toObject(csvData, csvOptions);
    for ( let i = 0; i < labelledData.length; i++ ) {
        let legalCertainty = 1.0;
        let classCertainty = 1.0;
        let label = labelledData[i].label || "";
        let legal = "legal" == labelledData[i].legal;
        db.cleanContent.update({
            primaryLabel: labelModelsByLabel[label],
            legal: legal,
            legalCertainty: legalCertainty,
            classCertainty: classCertainty,
        }, {
            where: {
                cleanContentId: {
                    [Op.eq]: labelledData[i].cleanContentId,
                },
            },
        });
    }
}

/**
 * Train the model on the passed data set. The function does not return anything
 * but updates the models in the global variables.
 * @param  {Array.<Object>} dataset The object contain a clean content model, a
 *                                  BoW vector and the expected labels legal and
 *                                  class id.
 */
async function trainModel(dataset) {
    // body...
}

/**
 * Apply the model to the provided dataset. The function does not return
 * anything, but updates the models in the global variables.
 * @param  {Arra.<Object>} dataset The objects contain a clean content model and
 *                                 a BoW vector. The estimated labels and
 *                                 certainties can then be directly written
 *                                 onto the clean content model to be
 *                                 persistently stored in the database
 */
async function applyModel(dataset) {
    // body...
}

// let clf = new svm.C_SVC({
//     kFold: 4,
//     normalize: true,
//     reduce: true,
//     cacheSize: 1024,
//     shrinking: true,
//     probability: true,
// });

// clf
//     .train(dataset)
//     .progress((rate) => {
//         // log to stdout
//     })
//     .spread((model, report) => {
//         // log report
//         // store model
//         // go ahead and apply model
//         // this is only the backbone structure
//     });

async function run () {
    // first check the mode we should run in...
    // mode supports either train, apply or insert
    // train: train the classifier on the training data available from the db
    // apply: apply the model to the not yet classified entries
    // insert: only insert manuall labelled content, do nothing else
    // default:
    //      no train file specified: apply
    //      train specified: insert, then train
    await loadModels();
    let mode = commandLineOptions.mode;
    if ( !mode ) {
        if ( commandLineOptions.labelled_dataset ) {
            mode = "train";
        } else if ( legalModel != {} && classModel != {} ) {
            mode = "apply";
        } else {
            console.log("Cannot apply empty model. Please train first");
            process.exit(-1);
        }
    } else {
        if (
            mode === "apply"
            && legalModel == {}
            && classModel == {}
        ) {
            console.log("Cannot apply empty model. Please train first");
            process.exit(-1);
        }
    }
    if ( commandLineOptions.labelled_dataset ) {
        await addTrainData();
    }
    let quantile = ; 
    let limit = ;
    if (mode === "train") {
        let dataset = await db.cleanContent.getTrainingData(limit, quantile);
        await trainModel(dataset);
    } else if (mode === "apply") {
        let dataset = await db.cleanContent.getLabellingData(limit, quantile);
        await applyModel(dataset);
    }
}

run();
