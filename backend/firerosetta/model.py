"""The regression head used during training.

This class is deliberately **not** what gets pickled. A bundle containing a project class
can only be opened where that project is importable, which would make the published model
useless to anyone who just downloaded the release. So `forecast.py` saves `link.gbm` and
`link.iso` as two plain scikit-learn estimators, and the consumer re-applies the two steps:

    counts = iso.predict(gbm.predict(X))

The same ordering is spelled out in the bundle's own `predict_recipe` field.
"""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.isotonic import IsotonicRegression


class Link:
    """Gradient-boosted trees on log1p(count), then isotonic recalibration back to counts.

    The log target keeps the huge dynamic range of monthly fire counts learnable, but
    exponentiating a mean in log space under-predicts big months badly: measured without
    this step the hindcast ran -34% overall and 0.56x on the top decile of real fire
    months. Isotonic regression maps the model's own output back onto observed counts,
    which fixes the level while preserving the ranking. Same construction, and the same
    reason, as the harmonization link in harmonize.py.
    """

    def __init__(self, **params):
        self.params = params

    def fit(self, X, y):
        self.gbm = HistGradientBoostingRegressor(
            max_iter=400, early_stopping=True, n_iter_no_change=25,
            validation_fraction=0.12, random_state=0, **self.params)
        self.gbm.fit(X, np.log1p(y))
        self.iso = IsotonicRegression(y_min=0, out_of_bounds="clip").fit(self.gbm.predict(X), y)
        return self

    def predict(self, X):
        return self.iso.predict(self.gbm.predict(X))
