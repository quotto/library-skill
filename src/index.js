'use strict';

const Alexa = require('ask-sdk');

const APP_ID = "your skill id";

let skill;
exports.handler = async function(event,context) {
    if(!skill) {
        skill = Alexa.SkillBuilders.custom()
            .addRequestHandlers(
                LaunchRequestHandler,
                SearchBookHandler,
                HelpIntentHandler,
                CancelAndStopIntentHandler,
                SessionEndedRequestHandler
            )
            .withApiClient(new Alexa.DefaultApiClient())
            .create();
    }
    return skill.invoke(event,context);
};

const PERMISSIONS = ['read::alexa:device:all:address'];

const axios = require('axios');
const amazon = require('amazon-product-api');
const calil_apikey= process.env.CALIL_KEY;

const amazon_client = amazon.createClient({
    awsId: process.env.AWS_ID,
    awsSecret: process.env.AWS_SECRET,
    awsTag: process.env.AWS_TAG
})


// カーリルAPIで貸出状況を検索する
// 貸出中であれば最大3回まで、2秒おきに検索する。
const recursiveBookSearch = async function(isbn,systemid,count=0,session="") {
    let url = `http://api.calil.jp/check?appkey=${calil_apikey}&isbn=${isbn}&systemid=${systemid}&format=json&callback=no`;
    if(session) {
        url = url + `&session=${session}`;
    }
    const bookdata = (await axios.get(url)).data;
    if(bookdata.continue && count < 3) {
        return await new Promise(resolve=>{
            setTimeout(()=>{
                console.log(`[INFO] continue:${count+1}`);
                resolve(recursiveBookSearch(isbn,systemid,count+1,bookdata.session));
            },2000);
        });
    } else{
        return bookdata;
    }
};

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'LaunchRequest';
    },
    handle(handlerInput) {
        const speechText = 'あなたが読みたい本が、近くの図書館で借りられるかを調べます。借りたい本のタイトルを教えてください。';
        return handlerInput.responseBuilder
            .speak(speechText)
            .reprompt()
            .getResponse();
    }
};

const SearchBookHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'IntentRequest'
            && handlerInput.requestEnvelope.request.intent.name === "SearchBook";
    },
    async handle(handlerInput) {
        const { responseBuilder,requestEnvelope,serviceClientFactory} = handlerInput;
        const consentToken = handlerInput.requestEnvelope.context.System.user.permissions && handlerInput.requestEnvelope.context.System.user.permissions.consentToken;
        if(!consentToken) {
            return responseBuilder
                .speak('住所情報の利用が許可されていません。アレクサアプリに表示されたカードから利用を許可してください。')
                .withAskForPermissionsConsentCard(PERMISSIONS)
                .getResponse();
        }
        const request = handlerInput.requestEnvelope.request;

        let address;
        try {
            const { requestEnvelope, serviceClientFactory } = handlerInput;
            const { deviceId } = requestEnvelope.context.System.device;
            const deviceAddressServiceClient = serviceClientFactory.getDeviceAddressServiceClient();
            address = await deviceAddressServiceClient.getFullAddress(deviceId);
            console.log("[DEBUG] get postalcode");
            if(!address.postalCode) {
                return responseBuilder
                        .speak('住所情報に郵便番号が設定されていません。アレクサアプリから郵便番号を設定してください。')
                        .getResponse();
            }
        }　catch(error) {
            console.log("[DEBUG] catch error");
            if(error.name === "ServiceError") {
                console.log(`[ERROR] StatusCode: ${error.statusCode} ${error.message}`);
            }
            return responseBuilder
                .speak('住所情報の取得に失敗しました。アレクサアプリから設定を確認してください。')
                .getResponse();
        }

        //リクエストからbooktitleを取得
        const booktitle = request.intent.slots.book.value;
        if(!booktitle) {
            return responseBuilder
                .speak('本のタイトルを教えてください。')
                .reprompt()
                .getResponse();
        }
        console.log(`[INFO] User spoke: ${booktitle}`);

        // Amazon product advertising APIにより指定されたキーワードにマッチする本のISBNを取得する
        // 最初にISBNコードが取得できたものが対象
        const query = {
            Keywords: booktitle,
            searchIndex: "Books",
            responseGroup: "ItemAttributes",
            domain: 'webservices.amazon.co.jp'
        }

        const amazon_search_result = await amazon_client.itemSearch(query)
                                            .then(function(results) {return results;})
                                            .catch(function(error) {return error;});
        console.log('[INFO] Amazon Search Result:' + JSON.stringify(amazon_search_result));

        // Amazonで対象商品が見つからなければエラー
        let isbn,product_title;
        let amazon_check = false;
        if(!amazon_search_result[0].Error && !amazon_search_result.Error) {
            for(var i=0; i<amazon_search_result.length; i++) {
                if(amazon_search_result[i].ItemAttributes[0]['ISBN'] && amazon_search_result[i].ItemAttributes[0]['ISBN'][0].match(/^\d+$/)) {
                    isbn = amazon_search_result[i].ItemAttributes[0]['ISBN'][0];
                    product_title = amazon_search_result[i].ItemAttributes[0]['Title'][0];
                    amazon_check = true;
                    break;
                }
            }
        }
        if(!amazon_check) {
            return responseBuilder
                    .speak(`${booktitle}、に当てはまる本は見つかりませんでした。`)
                    .getResponse();
        }
        console.log(`[INFO] Found in Amazon: ${product_title}:${isbn}`);


        //郵便番号をもとにおおよその緯度,軽度を取得
        console.log("[DEBGU] call geoapi");
            const geodata = await axios.get(`http://geoapi.heartrails.com/api/json?method=searchByPostal&postal=${address.postalCode}`);
        if(geodata.status != 200 || geodata.data.response.error) {
            console.log('[DEBUG] geo api error');
            return responseBuilder
                    .speak(`すみません、設定されている住所には対応していません。`)
                    .getResponse();
        }

        const geocode = `${geodata.data.response.location[0].x},${geodata.data.response.location[0].y}`;

        //カーリルAPIへ問い合わせ
        console.log("[DEBGU] call calil api");
        const calilresponse = await axios.get(`http://api.calil.jp/library?appkey=${calil_apikey}&limit=10&format=json&geocode=${geocode}&callback= `);
        if(calilresponse.status != 200) {
            console.log('[DEBUG] calil api error');
            return responseBuilder
                    .speak(`すみません、設定されている住所には対応していません。`)
                    .getResponse();
        }

        const librarydata = calilresponse.data;
        let reservedstatus = {}; // systemidごとのlibkeyを保持する
        const enable_library = []; // APIから取得した貸出状況とreservedstatusを突き合わせ、貸出可能な場合に図書館の正式名称を格納する
        for(var i=0; i<librarydata.length; i++) {
            const systemid = librarydata[i].systemid;
            const libkey = librarydata[i].libkey;
            console.log('[INFO] Found Library Data:' + JSON.stringify(librarydata[i]));

            // 一度もsystemidを検索していない場合はカーリルAPIで問い合わせる
            if(typeof(reservedstatus[systemid]) === "undefined") {
                const reserveddata = await recursiveBookSearch(isbn,systemid);
                console.log('[INFO] Get Reserved Status:' + JSON.stringify(reserveddata));
                const libkeystatus = reserveddata.books[isbn][systemid].libkey;
                const calilstatus = reserveddata.books[isbn][systemid].status;
                const reserveurl = reserveddata.books[isbn][systemid].reserveurl;
                if( (calilstatus === 'OK' || calilstatus === "Cache") && Object.keys(libkeystatus).length > 0) {
                    // 対象systemidについてのlibkey（systemidに紐づく図書館ごとの貸出状態）とreserveurlを格納する
                    reservedstatus[systemid] = {libkey:libkeystatus,url:reserveurl};
                }
            }

            if(reservedstatus[systemid] && reservedstatus[systemid].libkey[libkey] === "貸出可") {
                enable_library.push({name:librarydata[i].formal,url:reservedstatus[systemid].url});
            }
        }

        if(enable_library.length > 0) {
            let cardText = ``
            let speechText = `${product_title}、が借りられる近くの図書館は、`;
            for(var i=0; i< enable_library.length; i++) {
                speechText += `${enable_library[i].name}、`
                cardText += `${enable_library[i].name}:${enable_library[i].url}\n\n`;
            }
            speechText += "です。詳しい情報はアレクサアプリに表示されたURLを確認してください。";

            return responseBuilder
                    .speak(speechText)
                    .withSimpleCard(`${product_title}　が借りられる図書館`,cardText)
                    .getResponse();
        } else {
            return responseBuilder
                .speak(`${product_title}、が借りられる近くの図書館は見つかりませんでした。`)
                .getResponse();
        }
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'IntentRequest'
            && handlerInput.requestEnvelope.request.intent.name === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const speechText = 'あなたが読みたい本が、近くの図書館で借りられるか調べます。スキルの利用には住所情報の設定が必要です。'
                            +'図書館の検索には最大で1分ほどかかる場合があります。借りたい本のタイトルを教えてください。';

        return handlerInput.responseBuilder
            .speak(speechText)
            .reprompt(speechText)
            .getResponse();
    }
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'IntentRequest'
            && (handlerInput.requestEnvelope.request.intent.name === 'AMAZON.CancelIntent'
                || handlerInput.requestEnvelope.request.intent.name === 'AMAZON.StopIntent');
    },
    handle(handlerInput) {
        const speechText = 'また、使ってくださいね！';

        return handlerInput.responseBuilder
            .speak(speechText)
            .getResponse();
    }
};

const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder.getResponse();
    }
};
