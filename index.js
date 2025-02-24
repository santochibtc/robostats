//requires running index.py on the same server (index.py is located in this same github repo)
//also requires these two dependencies:
//npm i ws bech32 noble-secp256k1

var WebSocket = require( 'ws' ).WebSocket;
var nobleSecp256k1 = require( 'noble-secp256k1' );
var sha256 = nobleSecp256k1.utils.sha256;
var bytesToHex = bytes => bytes.reduce( ( str, byte ) => str + byte.toString( 16 ).padStart( 2, "0" ), "" );
var bech32 = require( 'bech32' );
var fs = require( 'fs' );

var password = ``;
var pubkey = nobleSecp256k1.getPublicKey( password, true ).substring( 2 );
var relay = `wss://junxingwang.org`;

console.log( "pubkey:" );
console.log( pubkey );

var nostr_image_host = {
    hexToBytes: hex => Uint8Array.from( hex.match( /.{1,2}/g ).map( ( byte ) => parseInt( byte, 16 ) ) ),
    bytesToHex: bytes => bytes.reduce( ( str, byte ) => str + byte.toString( 16 ).padStart( 2, "0" ), "" ),
    textToHex: text => {
        var encoder = new TextEncoder().encode( text );
        return [...new Uint8Array(encoder)]
            .map( x => x.toString( 16 ).padStart( 2, "0" ) )
            .join( "" );
    },
    hexToText: hex => {
        var bytes = new Uint8Array(Math.ceil(hex.length / 2));
        for (var i = 0; i < hex.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        var text = new TextDecoder().decode( bytes );
        return text;
    },
    hexToBech32: ( prefix, hex ) => {
        var words = bech32.bech32m.toWords( nostr_image_host.hexToBytes( hex ) );
        return bech32.bech32m.encode( prefix, words, 10000 );
    },
    bech32ToHex: bech32string => {
        var decoded = bech32.bech32m.fromWords( bech32.bech32m.decode( bech32string, 10000 ).words );
        return nostr_image_host.bytesToHex( decoded );
    },
    hexToBase64: hex => btoa( hex.match( /\w{2}/g ).map( a => String.fromCharCode( parseInt( a, 16 ) ) ).join( "" ) ),
    waitSomeSeconds: num => {
        var num = num.toString() + "000";
        num = Number( num );
        return new Promise( resolve => setTimeout( resolve, num ) );
    },
    getNote: async item => {
        async function isNoteSetYet( note_i_seek ) {
            return new Promise( function( resolve, reject ) {
                if ( !note_i_seek ) {
                    setTimeout( async function() {
                        var msg = await isNoteSetYet( nostr_image_host[ item ] );
                        resolve( msg );
                    }, 100 );
                } else {
                    resolve( note_i_seek );
                }
            });
        }
        async function getTimeoutData() {
            var note_i_seek = await isNoteSetYet( nostr_image_host[ item ] );
            return note_i_seek;
        }
        var returnable = await getTimeoutData();
        return returnable;
    },
    getSignedEvent: async (event, privateKey) => {
        var eventData = JSON.stringify([
            0,                  // Reserved for future use
            event['pubkey'],        // The sender's public key
            event['created_at'],    // Unix timestamp
            event['kind'],      // Message “kind” or type
            event['tags'],      // Tags identify replies/recipients
            event['content']        // Your note contents
        ])
        event.id  = nostr_image_host.bytesToHex( await sha256( eventData ) );
        event.sig = await nobleSecp256k1.schnorr.sign( event.id, privateKey );
        return event;
    },
    sendNoteAndReturnId: async ( note, part, whole, socket, privKey, pubKey ) => {
        var event = {
            "content"    : note,
            "created_at" : Math.floor( Date.now() / 1000 ),
            "kind"       : 57009,
            "tags"       : [ [ "pieces", `${part} of ${whole}` ] ],
            "pubkey"     : pubKey,
        }
        var signedEvent = await nostr_image_host.getSignedEvent( event, privKey );
        socket.send(JSON.stringify([ "EVENT", signedEvent ]));
        return signedEvent.id;
    },
    uploadToNostr: async ( text, relay ) => {
        return new Promise( async ( resolve, reject ) => {
            if ( !relay ) return;
            if ( !relay.startsWith( "wss://" ) ) relay = "wss://" + relay;
            var b64 = Buffer.from( text ).toString('base64');
            var hash = nostr_image_host.bytesToHex( await sha256( b64 ) );
            var socket = new WebSocket( relay );
            var failure = false;
            socket.addEventListener('message', async function( e ) {
                if ( !JSON.parse( e.data )[ 2 ] ) failure = true;
            });
            socket.addEventListener('open', async function( e ) {
                var array = b64.match(/.{1,4000}/g);
                var privKey = nostr_image_host.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() );
                var pubKey = nobleSecp256k1.getPublicKey( privKey, true ).substring( 2 );
                nostr_image_host[ `n_${hash}_percent_done_uploading` ] = "0%";
                var i; for ( i=0; i<array.length; i++ ) {
                    var note = array[ i ];
                    var part = i + 1;
                    var whole = array.length;
                    var id = await nostr_image_host.sendNoteAndReturnId( note, part, whole, socket, privKey, pubKey );
                    if ( failure ) {
                        resolve ( "upload failed" );
                        break;
                    }
                    var percent = Number( ( ( part / whole ) * 100 ).toFixed( 2 ) );
                    nostr_image_host[ `n_${hash}_percent_done_uploading` ] = percent + "%";
                    console.log( `${percent}% done` )
                    if ( percent == 100 ) resolve( nostr_image_host.hexToBech32( "nimg", id + nostr_image_host.textToHex( relay ) ) );
                    await nostr_image_host.waitSomeSeconds( 60 );
                }
                socket.close();
            });
        });
    },
    load_file: ( file_id, relay ) => {
        return new Promise( function( resolve, reject ) {
            var pieces = [];
            var socket = new WebSocket( relay );
            nostr_image_host[ `n_${file_id}_percent_done_downloading` ] = `0%`;
            socket.addEventListener('message', async function( message ) {
                var [ type, subId, event ] = JSON.parse( message.data );
                var { kind, content, tags } = event || {}
                if (!event || event === true) return;
                if ( subId.startsWith( "0000" ) ) {
                    tags.forEach( async item => {
                        if ( item[ 0 ] == "pieces" ) {
                            var parts = item[ 1 ].split( " of " );
                            pieces[ Number( parts[ 0 ] ) - 1 ] = content;
                            if ( parts[ 0 ] == "1" ) {
                                if ( pieces.length == Number( parts[ 1 ] ) ) {
                                    var whole = pieces.join( "" );
                                    nostr_image_host[ `n_${file_id}_percent_done_downloading` ] = `100%`;
                                    nostr_image_host[ `nostr_image_${event.id}` ] = whole;
                                    socket.close();
                                    resolve( event.id );
                                }
                            } else {
                                var num_of_loaded_parts = 0;
                                pieces.forEach( item => {if ( item ) num_of_loaded_parts = num_of_loaded_parts + 1;} );
                                var percent = Number( ( ( num_of_loaded_parts / Number( parts[ 1 ] ) ) * 100 ).toFixed( 2 ) );
                                nostr_image_host[ `n_${file_id}_percent_done_downloading` ] = `${percent}%`;
                            }
                        }
                    });
                } else {
                    var subId   = "0000" + nostr_image_host.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() ).substring( 4, 16 );
                    var filter  = { "authors": [ event.pubkey ], kinds: [ 57009 ] }
                    var subscription = [ "REQ", subId, filter ];
                    socket.send(JSON.stringify( subscription ));
                }
            });
            socket.addEventListener('open', async function( e ) {
                var subId   = nostr_image_host.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() ).substring( 0, 16 );
                var filter  = { "ids": [ file_id ], kinds: [ 57009 ] }
                var subscription = [ "REQ", subId, filter ];
                socket.send(JSON.stringify( subscription ));
            });
        });
    },
    downloadFromNostr: async image_id => {
        image_id = nostr_image_host.bech32ToHex( image_id );
        var relay_hex = image_id.substring( 64 );
        var relay = nostr_image_host.hexToText( relay_hex );
        var file_id = image_id.substring( 0, 64 );
        var thing_i_need = await nostr_image_host.load_file( file_id, relay );
        var image_b64 = await nostr_image_host.getNote( `nostr_image_${thing_i_need}` );
        delete nostr_image_host[ `nostr_image_${thing_i_need}` ];
        return image_b64;
    }
}

var sendInfo = async info => {
    var event = await prepEvent( password, info, 57471 );
    console.log( event, relay );
    var id = await sendEvent( event, relay );
}

var sendEvent = ( event, relay ) => {
    var socket = new WebSocket( relay );
    socket.on( 'open', () => {
        var sendable = JSON.stringify( [ "EVENT", event ] );
        socket.send( sendable );
        setTimeout( () => {socket.close();}, 1000 );
    });
    return event.id;
}

var prepEvent = async ( privkey, msg, kind, tags ) => {
    var pubkey = nobleSecp256k1.getPublicKey( privkey, true ).substring( 2 );
    if ( !tags ) tags = [];
    var event = {
        "content": msg,
        "created_at": Math.floor( Date.now() / 1000 ),
        "kind": kind,
        "tags": tags,
        "pubkey": pubkey,
    }
    var signedEvent = await getSignedEvent( event, privkey );
    return signedEvent;
}

async function getSignedEvent( event, privateKey ) {
    var eventData = JSON.stringify([
        0,
        event['pubkey'],
        event['created_at'],
        event['kind'],
        event['tags'],
        event['content']
    ]);
    event.id = bytesToHex( await sha256( eventData ) );
    event.sig = await nobleSecp256k1.schnorr.sign( event.id, privateKey );
    return event;
}

var waitSomeSeconds = num => {
    var num = num.toString() + "000";
    num = Number( num );
    return new Promise( resolve => setTimeout( resolve, num ) );
}

var timer = async num_of_seconds => {
    await waitSomeSeconds( num_of_seconds );
    return "times up";
}

var currency_nums = {
    "1": "USD",
    "2": "EUR",
    "3": "JPY",
    "4": "GBP",
    "5": "AUD",
    "6": "CAD",
    "7": "CHF",
    "8": "CNY",
    "9": "HKD",
    "10": "NZD",
    "11": "SEK",
    "12": "KRW",
    "13": "SGD",
    "14": "NOK",
    "15": "MXN",
    "16": "BYN",
    "17": "RUB",
    "18": "ZAR",
    "19": "TRY",
    "20": "BRL",
    "21": "CLP",
    "22": "CZK",
    "23": "DKK",
    "24": "HRK",
    "25": "HUF",
    "26": "INR",
    "27": "ISK",
    "28": "PLN",
    "29": "RON",
    "30": "ARS",
    "31": "VES",
    "32": "COP",
    "33": "PEN",
    "34": "UYU",
    "35": "PYG",
    "36": "BOB",
    "37": "IDR",
    "38": "ANG",
    "39": "CRC",
    "40": "CUP",
    "41": "DOP",
    "42": "GHS",
    "43": "GTQ",
    "44": "ILS",
    "45": "JMD",
    "46": "KES",
    "47": "KZT",
    "48": "MYR",
    "49": "NAD",
    "50": "NGN",
    "51": "AZN",
    "52": "PAB",
    "53": "PHP",
    "54": "PKR",
    "55": "QAR",
    "56": "SAR",
    "57": "THB",
    "58": "TTD",
    "59": "VND",
    "60": "XOF",
    "61": "TWD",
    "62": "TZS",
    "63": "XAF",
    "64": "UAH",
    "65": "EGP",
    "66": "LKR",
    "67": "MAD",
    "68": "AED",
    "69": "TND",
    "70": "ETB",
    "71": "GEL",
    "72": "UGX",
    "73": "RSD",
    "74": "IRT",
    "75": "BDT",
    "76": "ALL",
    "300": "XAU",
    "1000": "BTC"
}

var summary_maker = async filenames => {
    var alldata = [];
    var thisdate = filenames[ 0 ].substring( 0, 7 );
    var i; for ( i=0; i<filenames.length; i++ ) {
        var filename = filenames[ i ];
        var dbtext = fs.readFileSync( filename ).toString();
        var json = JSON.parse( dbtext );
        alldata = [ ...alldata, ...json ];
    }

    var volume_this_month = 0;
    var contracts_this_month = 0;
    var eur_contracts_this_month = 0;
    var eur_volume_this_month = 0;
    var usd_contracts_this_month = 0;
    var usd_volume_this_month = 0;
    var cad_contracts_this_month = 0;
    var cad_volume_this_month = 0;
    var gbp_contracts_this_month = 0;
    var gbp_volume_this_month = 0;
    var btc_contracts_this_month = 0;
    var btc_volume_this_month = 0;
    var oth_contracts_this_month = 0;
    var oth_volume_this_month = 0;

    alldata.forEach( item => {
        item.currency = currency_nums[ item.currency ];
        if ( item.currency === "EUR" ) {
            eur_contracts_this_month = eur_contracts_this_month + 1;
            eur_volume_this_month = eur_volume_this_month + Number( item[ "volume" ] );
            eur_volume_this_month = Number( eur_volume_this_month.toFixed( 8 ) );
        } else if ( item.currency === "USD" ) {
            usd_contracts_this_month = usd_contracts_this_month + 1;
            usd_volume_this_month = usd_volume_this_month + Number( item[ "volume" ] );
            usd_volume_this_month = Number( usd_volume_this_month.toFixed( 8 ) );
        } else if ( item.currency === "CAD" ) {
            cad_contracts_this_month = cad_contracts_this_month + 1;
            cad_volume_this_month = cad_volume_this_month + Number( item[ "volume" ] );
            cad_volume_this_month = Number( cad_volume_this_month.toFixed( 8 ) );
        } else if ( item.currency === "GBP" ) {
            gbp_contracts_this_month = gbp_contracts_this_month + 1;
            gbp_volume_this_month = gbp_volume_this_month + Number( item[ "volume" ] );
            gbp_volume_this_month = Number( gbp_volume_this_month.toFixed( 8 ) );
        } else if ( item.currency === "BTC" ) {
            btc_contracts_this_month = btc_contracts_this_month + 1;
            btc_volume_this_month = btc_volume_this_month + Number( item[ "volume" ] );
            btc_volume_this_month = Number( btc_volume_this_month.toFixed( 8 ) );
        } else {
            oth_contracts_this_month = oth_contracts_this_month + 1;
            oth_volume_this_month = oth_volume_this_month + Number( item[ "volume" ] );
            oth_volume_this_month = Number( oth_volume_this_month.toFixed( 8 ) );
        }

        contracts_this_month = contracts_this_month + 1;
        volume_this_month = volume_this_month + Number( item[ "volume" ] );
        volume_this_month = Number( volume_this_month.toFixed( 8 ) );
    });

    var monthly_summary = {
        this_summarys_date: thisdate,
        volume_this_month,
        contracts_this_month,
        eur_contracts_this_month,
        eur_volume_this_month,
        usd_contracts_this_month,
        usd_volume_this_month,
        cad_contracts_this_month,
        cad_volume_this_month,
        gbp_contracts_this_month,
        gbp_volume_this_month,
        btc_contracts_this_month,
        btc_volume_this_month,
        oth_contracts_this_month,
        oth_volume_this_month,
    }

    var text_for_nimg = `
        this_summarys_date: ${thisdate}\r
        volume_this_month: ${volume_this_month}\r
        contracts_this_month: ${contracts_this_month}\r
        eur_contracts_this_month: ${eur_contracts_this_month}\r
        eur_volume_this_month: ${eur_volume_this_month}\r
        usd_contracts_this_month: ${usd_contracts_this_month}\r
        usd_volume_this_month: ${usd_volume_this_month}\r
        cad_contracts_this_month: ${cad_contracts_this_month}\r
        cad_volume_this_month: ${cad_volume_this_month}\r
        gbp_contracts_this_month: ${gbp_contracts_this_month}\r
        gbp_volume_this_month: ${gbp_volume_this_month}\r
        btc_contracts_this_month: ${btc_contracts_this_month}\r
        btc_volume_this_month: ${btc_volume_this_month}\r
        oth_contracts_this_month: ${oth_contracts_this_month}\r
        oth_volume_this_month: ${oth_volume_this_month}\r
        \r
        details_on_contracts_this_month:\r
        ${JSON.stringify( alldata )}
    `;

    var image_id = await nostr_image_host.uploadToNostr( text_for_nimg, relay );
    if ( image_id.startsWith( "nimg" ) ) monthly_summary[ "file_id" ] = image_id;

    var texttowrite = JSON.stringify( monthly_summary );
    var summary_name = filename.substring( 0, 7 ) + "-summary.json";
    fs.writeFileSync( summary_name, texttowrite, function() {return;});
}

var init = async () => {
    var operators = [
        [ "the_big_lake", "4t4jxmivv6uqej6xzx2jx3fxh75gtt65v3szjoqmc4ugdlhipzdat6yd" ],
        [ "bitcoin_veneto", "mmhaqzuirth5rx7gl24d4773lknltjhik57k7ahec5iefktezv4b3uid" ],
        [ "satstralia", "satstraoq35jffvkgpfoqld32nzw2siuvowanruindbfojowpwsjdgad" ],
        [ "temple_of_sats", "ngdk7ocdzmz5kzsysa3om6du7ycj2evxp2f2olfkyq37htx3gllwp2yd" ],
        // [ "experimental", "robosats6tkf3eva7x2voqso3a5wcorsnw34jveyxfqi2fu7oyheasid" ],
    ];

    //Download all files from all operators
    //-- in the following helpers, note that the format is day-month-year
    //-- this helps: http://4t4jxmivv6uqej6xzx2jx3fxh75gtt65v3szjoqmc4ugdlhipzdat6yd.onion/api/ticks/?start=01-01-2024&end=01-02-2024&format=json
    //-- this helps: http://mmhaqzuirth5rx7gl24d4773lknltjhik57k7ahec5iefktezv4b3uid.onion/api/ticks/?start=01-03-2024&end=01-04-2024&format=json
    //-- this helps: http://satstraoq35jffvkgpfoqld32nzw2siuvowanruindbfojowpwsjdgad.onion/api/ticks/?start=01-05-2024&end=01-06-2024&format=json
    //-- this helps: http://ngdk7ocdzmz5kzsysa3om6du7ycj2evxp2f2olfkyq37htx3gllwp2yd.onion/api/ticks/?start=01-01-2024&end=01-02-2024&format=json
    //-- this helps: http://robosats6tkf3eva7x2voqso3a5wcorsnw34jveyxfqi2fu7oyheasid.onion/api/ticks/?start=01-01-2024&end=01-02-2024&format=json

    //Get a list of non-summary files [done]
    var dir = './';
    var files = [];
    var bigger_files = [];
    fs.readdirSync( dir ).forEach( file => files.push( file ) );
    var i; for ( i=0; i<files.length; i++ ) {
        var item = files[ i ];
        var index = i;
        if ( !item.endsWith( ".json" ) ) {
            files.splice( index, 1 );
            i = i - 1;
        }
        if ( item.includes( "package" ) ) {
            files.splice( index, 1 );
            i = i - 1;
        }
    }
    files.sort();
    bigger_files = JSON.parse( JSON.stringify( files ) );
    var i; for ( i=0; i<files.length; i++ ) {
        var item = files [ i ];
        var index = i;
        if ( item.endsWith( "summary.json" ) ) {
            files.splice( index, 1 );
            i = i - 1;
        }
    }

    //Get today's date
    var todays_date_long = new Date().toLocaleDateString();
    var todays_year = todays_date_long.substring( todays_date_long.length - 4 );
    var todays_month = todays_date_long.substring( 0, todays_date_long.indexOf( "/" ) );
    if ( todays_month.length != 2 ) todays_month = "0" + todays_month;
    var todays_date = todays_year + "-" + todays_month;

    //Check if you have all non-summary files, and if not, download them
    var year_for_this_part = todays_year;
    var last_month = Number( todays_month ) - 1;
    if ( !last_month ) {
        last_month = "12";
        year_for_this_part = String( Number( todays_year ) - 1 );
    }
    last_month = String( last_month );
    if ( last_month.length === 1 ) last_month = "0" + last_month;
    var date_for_this_part = year_for_this_part + "-" + last_month;
    var is_included = false;
    files.forEach( item => {
        if ( item.substring( 0, 7 ) === date_for_this_part ) is_included = true;
    });
    if ( !is_included ) {
        var i; for ( i=0; i<operators.length; i++ ) {
            var item = operators[ i ];
            var url = `http://${item[ 1 ]}.onion/api/ticks/?start=01-${last_month}-${year_for_this_part}&end=01-${todays_month}-${todays_year}&format=json`;
            if ( url.includes( ".onion/" ) ) url = `http://127.0.0.1:5000/?endpoint=${url}&pw=${password}`;
            var info_1 = await fetch( url );
            var info_2 = await info_1.json();
            console.log( `got info from ${item[ 0 ]}` );
            var suffix = "";
            if ( item[ 0 ] === "temple_of_sats" ) suffix = "Temple-Of-Sats";
            if ( item[ 0 ] === "the_big_lake" ) suffix = "The-Big-Lake";
            if ( item[ 0 ] === "bitcoin_veneto" ) suffix = "Bitcoin-Veneto";
            if ( item[ 0 ] === "satstralia" ) suffix = "Satstralia";
            var nonsummary_name = year_for_this_part + "-" + last_month + "-" + suffix + ".json";
            var texttowrite = JSON.stringify( info_2 );
            fs.writeFileSync( nonsummary_name, texttowrite, function() {return;});
        }
    }

    //Query for new non-summary data regarding the current month from each operator
    var this_month_data = [];
    var next_month = String( Number( todays_month ) + 1 );
    var year_to_use = todays_year;
    if ( next_month.length != 2 ) next_month = "0" + next_month;
    if ( next_month === "13" ) {
        next_month = "01";
        year_to_use = String( Number( year_to_use ) + 1 );
    }
    var i; for ( i=0; i<operators.length; i++ ) {
        var item = operators[ i ];
        var url = `http://${item[ 1 ]}.onion/api/ticks/?start=01-${todays_month}-${todays_year}&end=01-${next_month}-${year_to_use}&format=json`;
        if ( url.includes( ".onion/" ) ) url = `http://127.0.0.1:5000/?endpoint=${url}&pw=${password}`;
        var info_1 = await fetch( url );
        var info_2 = await info_1.json();
        console.log( `got info from ${item[ 0 ]}` );
        this_month_data = [ ...this_month_data, ...info_2 ];
    }

    //For each non-summary file, check if it has a summary file
    var potentially_several_files = [];
    var i; for ( i=0; i<files.length; i++ ) {
        var item = files[ i ];
        var summary_name = item.substring( 0, 7 ) + "-summary.json";
        if ( bigger_files.includes( summary_name ) ) continue;
        var potentially_several_files = [];
        files.forEach( file => {
            if ( file.substring( 0, 7 ) === item.substring( 0, 7 ) ) potentially_several_files.push( file );
        });
    }
    //If not, make one
    if ( potentially_several_files.length ) summary_maker( potentially_several_files );
    //Every day, summarize and publish the latest info from the summary files + the latest non-summary data
    var summary_filenames = [];
    fs.readdirSync( dir ).forEach( file => summary_filenames.push( file ) );
    var i; for ( i=0; i<summary_filenames.length; i++ ) {
        var item = summary_filenames[ i ];
        var index = i;
        if ( !item.endsWith( "-summary.json" ) ) {
            summary_filenames.splice( index, 1 );
            i = i - 1;
        }
    }
    summary_filenames.sort();
    var summaries = [];
    var i; for ( i=0; i<summary_filenames.length; i++ ) {
        var filename = summary_filenames[ i ];
        var summary_text = fs.readFileSync( filename ).toString();
        var summary = JSON.parse( summary_text );
        summaries.push( summary );
    }

    var volume_this_month = 0;
    var contracts_this_month = 0;
    var eur_contracts_this_month = 0;
    var eur_volume_this_month = 0;
    var usd_contracts_this_month = 0;
    var usd_volume_this_month = 0;
    var cad_contracts_this_month = 0;
    var cad_volume_this_month = 0;
    var gbp_contracts_this_month = 0;
    var gbp_volume_this_month = 0;
    var btc_contracts_this_month = 0;
    var btc_volume_this_month = 0;
    var oth_contracts_this_month = 0;
    var oth_volume_this_month = 0;

    this_month_data.forEach( item => {
        item.currency = currency_nums[ item.currency ];
        if ( item.currency === "EUR" ) {
            eur_contracts_this_month = eur_contracts_this_month + 1;
            eur_volume_this_month = eur_volume_this_month + Number( item[ "volume" ] );
            eur_volume_this_month = Number( eur_volume_this_month.toFixed( 8 ) );
        } else if ( item.currency === "USD" ) {
            usd_contracts_this_month = usd_contracts_this_month + 1;
            usd_volume_this_month = usd_volume_this_month + Number( item[ "volume" ] );
            usd_volume_this_month = Number( usd_volume_this_month.toFixed( 8 ) );
        } else if ( item.currency === "CAD" ) {
            cad_contracts_this_month = cad_contracts_this_month + 1;
            cad_volume_this_month = cad_volume_this_month + Number( item[ "volume" ] );
            cad_volume_this_month = Number( cad_volume_this_month.toFixed( 8 ) );
        } else if ( item.currency === "GBP" ) {
            gbp_contracts_this_month = gbp_contracts_this_month + 1;
            gbp_volume_this_month = gbp_volume_this_month + Number( item[ "volume" ] );
            gbp_volume_this_month = Number( gbp_volume_this_month.toFixed( 8 ) );
        } else if ( item.currency === "BTC" ) {
            btc_contracts_this_month = btc_contracts_this_month + 1;
            btc_volume_this_month = btc_volume_this_month + Number( item[ "volume" ] );
            btc_volume_this_month = Number( btc_volume_this_month.toFixed( 8 ) );
        } else {
            oth_contracts_this_month = oth_contracts_this_month + 1;
            oth_volume_this_month = oth_volume_this_month + Number( item[ "volume" ] );
            oth_volume_this_month = Number( oth_volume_this_month.toFixed( 8 ) );
        }

        contracts_this_month = contracts_this_month + 1;
        volume_this_month = volume_this_month + Number( item[ "volume" ] );
        volume_this_month = Number( volume_this_month.toFixed( 8 ) );
    });

    var monthly_summary = {
        this_summarys_date: todays_date,
        volume_this_month,
        contracts_this_month,
        eur_contracts_this_month,
        eur_volume_this_month,
        usd_contracts_this_month,
        usd_volume_this_month,
        cad_contracts_this_month,
        cad_volume_this_month,
        gbp_contracts_this_month,
        gbp_volume_this_month,
        btc_contracts_this_month,
        btc_volume_this_month,
        oth_contracts_this_month,
        oth_volume_this_month,
    }

    summaries = [ ...summaries, monthly_summary ];

    var cum_volume = 0;
    var cum_contracts = 0;
    var cum_eur_volume = 0;
    var cum_usd_volume = 0;
    var cum_cad_volume = 0;
    var cum_gbp_volume = 0;
    var cum_btc_volume = 0;
    var cum_oth_volume = 0;
    var cum_eur_contracts = 0;
    var cum_usd_contracts = 0;
    var cum_cad_contracts = 0;
    var cum_gbp_contracts = 0;
    var cum_btc_contracts = 0;
    var cum_oth_contracts = 0;

    summaries.forEach( summary => {
        cum_volume = cum_volume + summary[ "volume_this_month" ];
        cum_volume = Number( cum_volume.toFixed( 8 ) );
        cum_contracts = cum_contracts + summary[ "contracts_this_month" ];
        cum_eur_volume = cum_eur_volume + summary[ "eur_volume_this_month" ];
        cum_eur_volume = Number( cum_eur_volume.toFixed( 8 ) );
        cum_eur_contracts = cum_eur_contracts + summary[ "eur_contracts_this_month" ];
        cum_usd_volume = cum_usd_volume + summary[ "usd_volume_this_month" ];
        cum_usd_volume = Number( cum_usd_volume.toFixed( 8 ) );
        cum_usd_contracts = cum_usd_contracts + summary[ "usd_contracts_this_month" ];
        cum_cad_volume = cum_cad_volume + summary[ "cad_volume_this_month" ];
        cum_cad_volume = Number( cum_cad_volume.toFixed( 8 ) );
        cum_cad_contracts = cum_cad_contracts + summary[ "cad_contracts_this_month" ];
        cum_gbp_volume = cum_gbp_volume + summary[ "gbp_volume_this_month" ];
        cum_gbp_volume = Number( cum_gbp_volume.toFixed( 8 ) );
        cum_gbp_contracts = cum_gbp_contracts + summary[ "gbp_contracts_this_month" ];
        cum_btc_volume = cum_btc_volume + summary[ "btc_volume_this_month" ];
        cum_btc_volume = Number( cum_btc_volume.toFixed( 8 ) );
        cum_btc_contracts = cum_btc_contracts + summary[ "btc_contracts_this_month" ];
        cum_oth_volume = cum_oth_volume + summary[ "oth_volume_this_month" ];
        cum_oth_volume = Number( cum_oth_volume.toFixed( 8 ) );
        cum_oth_contracts = cum_oth_contracts + summary[ "oth_contracts_this_month" ];
    });

    var daily_report = {
        cum_volume,
        cum_contracts,
        cum_eur_volume,
        cum_usd_volume,
        cum_cad_volume,
        cum_gbp_volume,
        cum_btc_volume,
        cum_oth_volume,
        cum_eur_contracts,
        cum_usd_contracts,
        cum_cad_contracts,
        cum_gbp_contracts,
        cum_btc_contracts,
        cum_oth_contracts,
    }

    sendInfo( JSON.stringify( daily_report ) );
    await waitSomeSeconds( 86400 );
    return init();
}
init();
