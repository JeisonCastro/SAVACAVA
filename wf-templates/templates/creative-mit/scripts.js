/*!
* Start Bootstrap - Creative v7.0.7 (https://startbootstrap.com/theme/creative)
* Copyright 2013-2023 Start Bootstrap
* Licensed under MIT (https://github.com/StartBootstrap/startbootstrap-creative/blob/master/LICENSE)
* Adaptado por AUVRO Web Factory: sin plugin SimpleLightbox (portfolio con gradientes).
*/
window.addEventListener('DOMContentLoaded', event => {
    var navbarShrink = function () {
        const navbarCollapsible = document.body.querySelector('#mainNav');
        if (!navbarCollapsible) return;
        if (window.scrollY === 0) navbarCollapsible.classList.remove('navbar-shrink');
        else navbarCollapsible.classList.add('navbar-shrink');
    };
    navbarShrink();
    document.addEventListener('scroll', navbarShrink);
    const mainNav = document.body.querySelector('#mainNav');
    if (mainNav && typeof bootstrap !== 'undefined') {
        new bootstrap.ScrollSpy(document.body, { target: '#mainNav', rootMargin: '0px 0px -40%' });
    }
    const navbarToggler = document.body.querySelector('.navbar-toggler');
    const responsiveNavItems = [].slice.call(document.querySelectorAll('#navbarResponsive .nav-link'));
    responsiveNavItems.map(function (item) {
        item.addEventListener('click', () => {
            if (navbarToggler && window.getComputedStyle(navbarToggler).display !== 'none') navbarToggler.click();
        });
    });
});
