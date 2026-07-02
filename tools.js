const express = require('express');
const router = express.Router();
const i18n = require('i18n');

function getLang(req) {
    return req.params.lang === 'ru' ? 'ru' : (req.session.lang || 'en');
}

function buildHeaderLocals(req, res) {
    const usernameCurrent = req.session.username || null;
    const profilePictureCurrent = res.locals.profilePicture || req.session.profilePicture || null;
    return {
        username: usernameCurrent,
        userId: req.session.userId || null,
        profilePicture: profilePictureCurrent,
        usernameCurrent,
        profilePictureCurrent,
    };
}

// Tools landing page
router.get('/', (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    res.render('tools/index', {
        __: i18n.__,
        lang,
        ...buildHeaderLocals(req, res),
    });
});

// Formula sheet
router.get('/formulas', (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    res.render('tools/formulas', {
        __: i18n.__,
        lang,
        ...buildHeaderLocals(req, res),
    });
});

// Unit converter
router.get('/units', (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    res.render('tools/units', {
        __: i18n.__,
        lang,
        ...buildHeaderLocals(req, res),
    });
});

// Physical constants
router.get('/constants', (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    res.render('tools/constants', {
        __: i18n.__,
        lang,
        ...buildHeaderLocals(req, res),
    });
});

// LaTeX equation editor
router.get('/latex', (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    res.render('tools/latex', {
        __: i18n.__,
        lang,
        ...buildHeaderLocals(req, res),
    });
});

module.exports = router;
