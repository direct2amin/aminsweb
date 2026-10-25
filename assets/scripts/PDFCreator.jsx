#target illustrator

function collectExportedImages(folder, fileList) {
    var items = folder.getFiles();
    for (var i = 0; i < items.length; i++) {
        if (items[i] instanceof Folder) {
            collectExportedImages(items[i], fileList);
        } else if (items[i] instanceof File && /\.(jpe?g|png)$/i.test(items[i].name)) {
            fileList.push(items[i]);
        }
    }
}

function removeFolderRecursive(folder) {
    if (!folder || !folder.exists) return;
    var items = folder.getFiles();
    for (var i = 0; i < items.length; i++) {
        if (items[i] instanceof Folder) {
            removeFolderRecursive(items[i]);
        } else {
            try { items[i].remove(); } catch (e) {}
        }
    }
    try { folder.remove(); } catch (e) {}
}

function getJpegInfo(binaryStr, fallbackW, fallbackH) {
    var len = binaryStr.length;
    var pos = 2; // Skip 0xFF 0xD8 (SOI)
    while (pos < len) {
        if (binaryStr.charCodeAt(pos) !== 0xFF) {
            pos++;
            continue;
        }
        while (pos < len && binaryStr.charCodeAt(pos) === 0xFF) {
            pos++;
        }
        if (pos >= len) break;

        var marker = binaryStr.charCodeAt(pos);
        pos++;

        if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
            continue;
        }
        if (marker === 0xDA) {
            break; // Start of Scan
        }
        if (pos + 1 >= len) break;

        var segLen = (binaryStr.charCodeAt(pos) << 8) | binaryStr.charCodeAt(pos + 1);
        if (segLen < 2) break;

        // SOF markers (Baseline, Extended, Progressive)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            var bits = binaryStr.charCodeAt(pos + 2);
            var height = (binaryStr.charCodeAt(pos + 3) << 8) | binaryStr.charCodeAt(pos + 4);
            var width = (binaryStr.charCodeAt(pos + 5) << 8) | binaryStr.charCodeAt(pos + 6);
            var channels = binaryStr.charCodeAt(pos + 7);
            return {
                width: width,
                height: height,
                bits: bits || 8,
                channels: channels || 3
            };
        }
        pos += segLen;
    }
    return {
        width: fallbackW,
        height: fallbackH,
        bits: 8,
        channels: 3
    };
}

function buildPdfSilentlyFromJpegs(imageFiles, pageDims, pdfFile) {
    var numPages = imageFiles.length;
    var currentOffset = 0;
    var offsets = [];

    pdfFile.encoding = "BINARY";
    pdfFile.lineFeed = "Unix";
    if (!pdfFile.open("w")) {
        throw new Error("Cannot open output PDF file for writing:\n" + pdfFile.fsName);
    }

    function writeChunk(str) {
        pdfFile.write(str);
        currentOffset += str.length;
    }

    try {
        // PDF 1.4 Header
        writeChunk("%PDF-1.4\n%" + String.fromCharCode(0xE2, 0xE3, 0xCF, 0xD3) + "\n");

        // Object 1: Catalog
        offsets[1] = currentOffset;
        writeChunk("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

        // Object 2: Pages Tree
        var kids = [];
        for (var k = 0; k < numPages; k++) {
            kids.push((3 + k * 3) + " 0 R");
        }
        offsets[2] = currentOffset;
        writeChunk("2 0 obj\n<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + numPages + " >>\nendobj\n");

        // Page, Content Stream, and Image XObject for each Artboard
        for (var i = 0; i < numPages; i++) {
            var imgFile = imageFiles[i];
            imgFile.encoding = "BINARY";
            if (!imgFile.open("r")) {
                throw new Error("Cannot read exported image:\n" + imgFile.fsName);
            }
            var jpegData = imgFile.read();
            imgFile.close();

            var wPt = pageDims[i].width;
            var hPt = pageDims[i].height;
            var wPtStr = wPt.toFixed(2);
            var hPtStr = hPt.toFixed(2);

            var info = getJpegInfo(jpegData, Math.round(wPt * 2), Math.round(hPt * 2));
            var colorSpace = "/DeviceRGB";
            var decodeParms = "";
            if (info.channels === 1) {
                colorSpace = "/DeviceGray";
            } else if (info.channels === 4) {
                colorSpace = "/DeviceCMYK";
                decodeParms = " /Decode [1 0 1 0 1 0 1 0]";
            }

            var pageObjNum = 3 + i * 3;
            var contentObjNum = 4 + i * 3;
            var imageObjNum = 5 + i * 3;

            offsets[pageObjNum] = currentOffset;
            writeChunk(
                pageObjNum + " 0 obj\n" +
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + wPtStr + " " + hPtStr + "] " +
                "/Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 " + imageObjNum + " 0 R >> >> " +
                "/Contents " + contentObjNum + " 0 R >>\n" +
                "endobj\n"
            );

            var contentStream = "q\n" + wPtStr + " 0 0 " + hPtStr + " 0 0 cm\n/Im0 Do\nQ\n";
            offsets[contentObjNum] = currentOffset;
            writeChunk(
                contentObjNum + " 0 obj\n" +
                "<< /Length " + contentStream.length + " >>\n" +
                "stream\n" +
                contentStream +
                "endstream\n" +
                "endobj\n"
            );

            offsets[imageObjNum] = currentOffset;
            writeChunk(
                imageObjNum + " 0 obj\n" +
                "<< /Type /XObject /Subtype /Image " +
                "/Width " + info.width + " /Height " + info.height + " " +
                "/ColorSpace " + colorSpace + decodeParms + " " +
                "/BitsPerComponent " + info.bits + " " +
                "/Filter /DCTDecode /Length " + jpegData.length + " >>\n" +
                "stream\n"
            );
            writeChunk(jpegData);
            writeChunk("\nendstream\nendobj\n");
        }

        // Cross-Reference Table (xref) and Trailer
        var totalObjs = 2 + numPages * 3;
        var xrefOffset = currentOffset;
        writeChunk("xref\n0 " + (totalObjs + 1) + "\n");
        writeChunk("0000000000 65535 f \n");
        for (var objIdx = 1; objIdx <= totalObjs; objIdx++) {
            var offStr = ("0000000000" + offsets[objIdx]).slice(-10);
            writeChunk(offStr + " 00000 n \n");
        }

        writeChunk(
            "trailer\n" +
            "<< /Size " + (totalObjs + 1) + " /Root 1 0 R >>\n" +
            "startxref\n" +
            xrefOffset + "\n" +
            "%%EOF\n"
        );
    } finally {
        pdfFile.close();
    }
}

function exportEmbedAndCleanUpV2() {
    if (app.documents.length === 0) {
        alert("Please! Open an illustrator file.");
        return;
    }

    var sourceDoc = app.activeDocument;
    var totalArtboards = sourceDoc.artboards.length;

    // Determine output folder (same folder as the .ai file)
    var outputFolder = null;
    try {
        if (sourceDoc.fullName && sourceDoc.fullName.parent && sourceDoc.fullName.parent.exists) {
            outputFolder = sourceDoc.fullName.parent;
        } else if (sourceDoc.path && sourceDoc.path.exists) {
            outputFolder = sourceDoc.path;
        }
    } catch (e) {}

    if (!outputFolder) {
        outputFolder = Folder.selectDialog("Please select a folder to save the PDF:");
        if (!outputFolder) return;
    }

    var docBaseName = decodeURI(sourceDoc.name).replace(/\.[^\.]+$/, "");
    var pdfFile = new File(outputFolder.fsName + "/" + docBaseName + ".pdf");

    // Temporary folder for 2x exported images
    var tempFolder = new Folder(Folder.temp.fsName + "/AI_Review_Temp_" + new Date().getTime());
    if (!tempFolder.exists) tempFolder.create();

    var prevInteractionLevel = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

    try {
        // 1. Record artboard sizes and temporarily set unique names for fast batch export
        var originalNames = [];
        var pageDims = [];
        for (var i = 0; i < totalArtboards; i++) {
            var ab = sourceDoc.artboards[i];
            originalNames.push(ab.name);
            ab.name = "__PAGE_" + (i + 1) + "__";

            var rect = ab.artboardRect;
            pageDims.push({
                width: Math.abs(rect[2] - rect[0]),
                height: Math.abs(rect[1] - rect[3])
            });
        }

        // 2. Batch export all artboards at 2x (100% quality JPEG) via Export for Screens
        try {
            var exportOptions = new ExportForScreensOptionsJPEG();
            exportOptions.antiAliasing = AntiAliasingMethod.ARTOPTIMIZED;
            exportOptions.compressionMethod = JPEGCompressionMethodType.BASELINESTANDARD;
            exportOptions.embedICCProfile = false;
            exportOptions.scaleType = ExportForScreensScaleType.SCALEBYFACTOR;
            exportOptions.scaleTypeValue = 2; // 2x scale

            var itemToExport = new ExportForScreensItemToExport();
            itemToExport.artboards = "all";
            itemToExport.document = false;

            sourceDoc.exportForScreens(
                tempFolder,
                ExportForScreensType.SE_JPEG100,
                exportOptions,
                itemToExport,
                ""
            );
        } finally {
            // Restore original artboard names immediately
            for (var r = 0; r < totalArtboards; r++) {
                sourceDoc.artboards[r].name = originalNames[r];
            }
        }

        // 3. Collect exported image files in exact artboard order
        var allExportedFiles = [];
        collectExportedImages(tempFolder, allExportedFiles);

        var imageFiles = [];
        for (var idx = 0; idx < totalArtboards; idx++) {
            var token = "__PAGE_" + (idx + 1) + "__";
            var matchedFile = null;
            for (var f = 0; f < allExportedFiles.length; f++) {
                if (decodeURI(allExportedFiles[f].name).indexOf(token) !== -1) {
                    matchedFile = allExportedFiles[f];
                    break;
                }
            }
            if (!matchedFile || !matchedFile.exists) {
                throw new Error("Could not find exported image for artboard " + (idx + 1));
            }
            imageFiles.push(matchedFile);
        }

        // 4. Silently build the multi-page PDF directly on disk (NO new Illustrator window opened!)
        buildPdfSilentlyFromJpegs(imageFiles, pageDims, pdfFile);

        // 5. Cleanup temporary files
        removeFolderRecursive(tempFolder);

        app.userInteractionLevel = prevInteractionLevel;
        alert("Congratulations Dear! Your PDF has been saved at:\n" + pdfFile.fsName);

    } catch (e) {
        removeFolderRecursive(tempFolder);
        app.userInteractionLevel = prevInteractionLevel;
        alert("Sorry, an error has occurred!\nError: " + e.message);
    }
}

exportEmbedAndCleanUpV2();
